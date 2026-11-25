import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { realpath, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenCodeConversationClient } from "../../../src/external/opencode/client";
import { GitModule } from "../../../src/modules/git/git.module";
import { createOpenCodeConversationClient } from "../../../src/external/opencode/client";
import { isAllowedTerminalHost, resolveWorktree } from "./terminals";

type Scope = { project: string; worktree: string; branch: string | null };
type StoredMessage = { role: "user" | "assistant"; text: string; createdAt: number };
type Conversation = Scope & {
  id: string;
  projectPath: string;
  projectIdentity: string;
  directory: string;
  directoryIdentity: string;
  nativeSessionID: string | null;
  activePromptID: string | null;
  hidden: boolean;
  status: "ready" | "active" | "blocked" | "incomplete";
  messages: StoredMessage[];
  updatedAt: number;
};
type Database = import("bun:sqlite").Database;

export type ConversationDependencies = {
  readProjects: () => Promise<Record<string, { name: string; path: string }>>;
  client?: OpenCodeConversationClient;
  databasePath?: string;
  worktrees?: typeof GitModule.worktrees;
};

export function createConversationMiddleware(dependencies: ConversationDependencies) {
  const client = dependencies.client ?? createOpenCodeConversationClient();
  const actions = new Set<string>();
  let databasePromise: Promise<Database> | undefined;
  let recoveryStarted = false;
  const database = async () => {
    const connection = await (databasePromise ??= openDatabase(dependencies.databasePath));
    if (!recoveryStarted) {
      recoveryStarted = true;
      void recoverConversations(connection, client, dependencies, actions).catch(() => {});
    }
    return connection;
  };

  return async (
    request: IncomingMessage & { originalUrl?: string },
    response: ServerResponse,
    next: () => void,
  ) => {
    const url = new URL(request.originalUrl ?? request.url ?? "/", "http://eden.local");
    if (!url.pathname.startsWith("/api/conversations")) return next();
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    if (!sameOrigin(request))
      return respond(response, 403, { error: "Cross-origin requests are not allowed." });

    try {
      const db = await database();
      if (!(await handleCollectionRequest(request, response, url, db, dependencies))) {
        const parts = url.pathname.split("/").filter(Boolean);
        await handleConversationRequest(
          request,
          response,
          parts,
          db,
          client,
          dependencies,
          actions,
        );
      }
    } catch {
      return respond(response, 400, { error: "Could not process conversation request." });
    }
  };
}

async function recoverConversations(
  database: Database,
  client: OpenCodeConversationClient,
  dependencies: ConversationDependencies,
  actions: Set<string>,
) {
  const conversations = database
    .query(
      "SELECT * FROM conversations WHERE status = 'incomplete' AND native_session_id IS NOT NULL",
    )
    .all()
    .map((row) => parseRow(row as Record<string, unknown>));
  for (const conversation of conversations) {
    if (!acquireAction(actions, conversation.id)) continue;
    void recoverConversation(database, conversation, client, dependencies, actions);
  }
}

async function observeConversation(
  database: Database,
  conversation: Conversation,
  client: OpenCodeConversationClient,
) {
  let settled = false;
  try {
    await client.observe(
      conversation.nativeSessionID!,
      conversation.directory,
      conversation.activePromptID!,
      (event) => {
        const message = lastAssistantMessage(conversation);
        if (event.type === "text" && message) message.text += event.delta;
        if (event.type === "blocked") conversation.status = "blocked";
        if (event.type === "settled") {
          settled = true;
          if (message) message.text = event.reply;
          conversation.status = "ready";
          conversation.activePromptID = null;
        }
        conversation.updatedAt = Date.now();
        save(database, conversation);
      },
    );
    if (!settled) {
      conversation.status = "incomplete";
      conversation.updatedAt = Date.now();
      save(database, conversation);
    }
  } catch {
    conversation.status = "incomplete";
    conversation.updatedAt = Date.now();
    save(database, conversation);
  }
}

async function recoverConversation(
  database: Database,
  conversation: Conversation,
  client: OpenCodeConversationClient,
  dependencies: ConversationDependencies,
  actions: Set<string>,
) {
  try {
    await resolveCurrentWorktree(conversation, dependencies);
    if (!conversation.nativeSessionID || !conversation.activePromptID) return;
    const result = await client.reconcileAvailable(
      conversation.nativeSessionID,
      conversation.directory,
      conversation.activePromptID,
    );
    if (!result) return;
    if (result.reply !== null) updateAssistantReply(conversation, result.reply);
    if (result.active) {
      conversation.status = "active";
      save(database, conversation);
      await observeConversation(database, conversation, client);
      return;
    }
    if (result.reply !== null) {
      conversation.status = "ready";
      conversation.activePromptID = null;
    } else {
      conversation.status = "incomplete";
    }
    save(database, conversation);
  } catch {
    conversation.status = "incomplete";
    save(database, conversation);
  } finally {
    releaseAction(actions, conversation.id);
  }
}

async function handleCollectionRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  database: Database,
  dependencies: ConversationDependencies,
) {
  if (url.pathname !== "/api/conversations") return false;
  if (request.method === "GET") {
    respond(response, 200, {
      ...list(
        database,
        url.searchParams.get("project"),
        url.searchParams.get("worktree"),
        url.searchParams.get("branch") || null,
      ),
    });
    return true;
  }
  if (request.method !== "POST") return false;
  const body = await readBody(request);
  const scope = parseScope(body);
  const projects = await dependencies.readProjects();
  const directory = await resolveWorktree(scope, {
    readProjects: async () => projects,
    worktrees: dependencies.worktrees,
  });
  const projectPath = await realpath(projects[scope.project]!.path);
  const conversation: Conversation = {
    ...scope,
    id: randomUUID(),
    projectPath,
    projectIdentity: await pathIdentity(projectPath),
    directory,
    directoryIdentity: await pathIdentity(directory),
    nativeSessionID: null,
    activePromptID: null,
    hidden: false,
    status: "ready",
    messages: [],
    updatedAt: Date.now(),
  };
  save(database, conversation);
  respond(response, 201, { conversation: publicConversation(conversation) });
  return true;
}

async function handleConversationRequest(
  request: IncomingMessage,
  response: ServerResponse,
  parts: string[],
  database: Database,
  client: OpenCodeConversationClient,
  dependencies: ConversationDependencies,
  actions: Set<string>,
) {
  const id = parts[2] ?? "";
  if (parts.length === 3 && request.method === "GET") {
    const conversation = get(database, id);
    if (!conversation) return respond(response, 404, { error: "Conversation not found." });
    return respond(response, 200, { conversation: publicConversation(conversation) });
  }
  if (
    parts.length === 4 &&
    (parts[3] === "close" || parts[3] === "reopen") &&
    request.method === "POST"
  ) {
    const body = await readBody(request);
    const scope = parseScope(body);
    const conversation = get(database, id);
    if (!conversation) return respond(response, 404, { error: "Conversation not found." });
    if (!sameScope(conversation, scope))
      return respond(response, 404, { error: "Conversation not found in this worktree." });
    conversation.hidden = parts[3] === "close";
    saveVisibility(database, conversation);
    return respond(response, 200, { conversation: publicConversation(conversation) });
  }
  if (parts.length === 4 && parts[3] === "stop" && request.method === "POST") {
    const conversation = get(database, id);
    if (!conversation) return respond(response, 404, { error: "Conversation not found." });
    if (
      (conversation.status !== "active" && conversation.status !== "blocked") ||
      !conversation.nativeSessionID
    )
      return respond(response, 409, { error: "There is no active reply to stop." });
    try {
      const { directory } = await resolveCurrentWorktree(conversation, dependencies);
      if (!(await client.interrupt(conversation.nativeSessionID, directory)))
        return respond(response, 409, { error: "OpenCode no longer has an active reply." });
      return respond(response, 202, {
        stopping: true,
        conversation: publicConversation(conversation),
      });
    } catch {
      return respond(response, 503, { error: "OpenCode could not stop this reply." });
    }
  }
  if (parts.length !== 4 || parts[3] !== "send" || request.method !== "POST")
    return respond(response, 405, { error: "Method not allowed." });
  if (!acquireAction(actions, id))
    return respond(response, 409, {
      error: "A conversation action is already in progress.",
    });
  try {
    const body = await readBody(request);
    if (typeof body.text !== "string" || !body.text.trim() || body.text.length > 16_000)
      return respond(response, 400, { error: "Enter a message of at most 16,000 characters." });
    const conversation = get(database, id);
    if (!conversation) return respond(response, 404, { error: "Conversation not found." });
    if (
      conversation.status === "incomplete" &&
      conversation.nativeSessionID &&
      !conversation.activePromptID
    )
      return respond(response, 409, {
        error: "This conversation has an unresolved prior turn and will not replay it.",
        conversation: publicConversation(conversation),
      });
    if (conversation.status === "active" || conversation.status === "blocked")
      return respond(response, 409, {
        error: "A reply is already in progress.",
        conversation: publicConversation(conversation),
      });
    return await sendMessage(
      database,
      conversation,
      body.text.trim(),
      client,
      response,
      dependencies,
      actions,
    );
  } finally {
    releaseAction(actions, id);
  }
}

async function sendMessage(
  database: Database,
  conversation: Conversation,
  text: string,
  client: OpenCodeConversationClient,
  response: ServerResponse,
  dependencies: ConversationDependencies,
  actions: Set<string>,
) {
  let promptAttempted = false;
  let appendedMessages: StoredMessage[] = [];
  try {
    const { directory } = await resolveCurrentWorktree(conversation, dependencies);
    await client.prepare(directory);
    if (conversation.nativeSessionID && conversation.activePromptID) {
      const reconciled = await client.reconcile(
        conversation.nativeSessionID,
        directory,
        conversation.activePromptID,
      );
      if (reconciled.active) {
        conversation.status = "active";
        if (reconciled.reply !== null) updateAssistantReply(conversation, reconciled.reply);
        save(database, conversation);
        scheduleObservation(database, conversation, client, actions);
        return respond(response, 409, {
          error: "The previous OpenCode turn is still in progress.",
          conversation: publicConversation(conversation),
        });
      }
      if (reconciled.reply === null)
        return respond(response, 409, {
          error: "The previous OpenCode turn could not be reconciled; it will not be replayed.",
          conversation: publicConversation(conversation),
        });
      updateAssistantReply(conversation, reconciled.reply);
      conversation.activePromptID = null;
      conversation.status = "ready";
      save(database, conversation);
    }

    if (!conversation.nativeSessionID) {
      conversation.nativeSessionID = await client.create(directory);
      save(database, conversation);
    } else {
      const state = await client.inspect(conversation.nativeSessionID, directory);
      if (state.active)
        return respond(response, 409, {
          error: "The linked OpenCode session is busy.",
          conversation: publicConversation(conversation),
        });
    }

    const promptID = `msg_${randomUUID().replaceAll("-", "")}`;
    const userMessage: StoredMessage = { role: "user", text, createdAt: Date.now() };
    const assistantMessage: StoredMessage = { role: "assistant", text: "", createdAt: Date.now() };
    appendedMessages = [userMessage, assistantMessage];
    conversation.messages.push(...appendedMessages);
    conversation.activePromptID = promptID;
    conversation.status = "active";
    save(database, conversation);

    const result = await client.send(
      conversation.nativeSessionID,
      directory,
      promptID,
      text,
      (event) => {
        if (event.type === "attempting") promptAttempted = true;
        if (event.type === "accepted") {
          conversation.activePromptID = event.userMessageID;
          conversation.updatedAt = Date.now();
          save(database, conversation);
        }
        if (event.type === "text") assistantMessage.text += event.delta;
        if (event.type === "blocked") conversation.status = "blocked";
        if (event.type === "settled") assistantMessage.text = event.reply;
        conversation.updatedAt = Date.now();
        save(database, conversation);
      },
    );
    assistantMessage.text = result.reply;
    conversation.status = "ready";
    conversation.activePromptID = null;
    conversation.updatedAt = Date.now();
    save(database, conversation);
    return respond(response, 200, { conversation: publicConversation(conversation) });
  } catch {
    if (conversation.activePromptID) {
      if (promptAttempted) {
        conversation.status = "incomplete";
      } else {
        conversation.messages = conversation.messages.filter(
          (message) => !appendedMessages.includes(message),
        );
        conversation.activePromptID = null;
        conversation.status = "ready";
      }
      conversation.updatedAt = Date.now();
      save(database, conversation);
    }
    return respond(response, 503, {
      error:
        "OpenCode could not complete this turn; it is marked incomplete and will not be replayed.",
      conversation: publicConversation(conversation),
    });
  }
}

function scheduleObservation(
  database: Database,
  conversation: Conversation,
  client: OpenCodeConversationClient,
  actions: Set<string>,
) {
  setImmediate(() => {
    if (!acquireAction(actions, conversation.id)) return;
    void observeConversation(database, conversation, client).finally(() =>
      releaseAction(actions, conversation.id),
    );
  });
}

async function resolveCurrentWorktree(
  conversation: Conversation,
  dependencies: ConversationDependencies,
) {
  const projects = await dependencies.readProjects();
  const project = Object.hasOwn(projects, conversation.project)
    ? projects[conversation.project]
    : null;
  if (!project || !conversation.projectPath)
    throw new Error("This conversation's registered project or worktree is stale.");
  const [registeredPath, savedPath] = await Promise.all([
    realpath(project.path),
    realpath(conversation.projectPath),
  ]);
  if (
    registeredPath !== savedPath ||
    !conversation.projectIdentity ||
    (await pathIdentity(registeredPath)) !== conversation.projectIdentity
  )
    throw new Error("This conversation belongs to a project path that has changed.");
  const directory = await resolveWorktree(conversation, {
    readProjects: async () => projects,
    worktrees: dependencies.worktrees,
  });
  if (
    directory !== (await realpath(conversation.directory)) ||
    !conversation.directoryIdentity ||
    (await pathIdentity(directory)) !== conversation.directoryIdentity
  )
    throw new Error("This conversation's worktree path has changed.");
  return { directory };
}

async function pathIdentity(path: string) {
  const details = await stat(path, { bigint: true });
  return `${details.dev}:${details.ino}`;
}

function updateAssistantReply(conversation: Conversation, reply: string) {
  const message = lastAssistantMessage(conversation);
  if (message) message.text = reply;
  else conversation.messages.push({ role: "assistant", text: reply, createdAt: Date.now() });
}

function lastAssistantMessage(conversation: Conversation) {
  return [...conversation.messages].reverse().find((message) => message.role === "assistant");
}

async function openDatabase(
  path = join(
    process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"),
    "eden",
    "conversations.sqlite",
  ),
) {
  const { chmod, mkdir } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const { Database } = await import("bun:sqlite");
  const database = new Database(path, { create: true, readwrite: true });
  await chmod(path, 0o600);
  database.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      project TEXT NOT NULL,
      project_path TEXT NOT NULL DEFAULT '',
      project_identity TEXT NOT NULL DEFAULT '',
      worktree TEXT NOT NULL,
      branch TEXT,
      directory TEXT NOT NULL,
      directory_identity TEXT NOT NULL DEFAULT '',
      native_session_id TEXT,
      active_prompt_id TEXT,
      hidden INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      messages TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  const columns = database
    .query("PRAGMA table_info(conversations)")
    .all()
    .map((column) => String((column as { name: string }).name));
  if (!columns.includes("project_path"))
    database.exec("ALTER TABLE conversations ADD COLUMN project_path TEXT NOT NULL DEFAULT ''");
  if (!columns.includes("project_identity"))
    database.exec("ALTER TABLE conversations ADD COLUMN project_identity TEXT NOT NULL DEFAULT ''");
  if (!columns.includes("directory_identity"))
    database.exec(
      "ALTER TABLE conversations ADD COLUMN directory_identity TEXT NOT NULL DEFAULT ''",
    );
  if (!columns.includes("active_prompt_id"))
    database.exec("ALTER TABLE conversations ADD COLUMN active_prompt_id TEXT");
  if (!columns.includes("hidden"))
    database.exec("ALTER TABLE conversations ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0");
  database.exec(
    "UPDATE conversations SET status = 'incomplete' WHERE status IN ('active', 'blocked')",
  );
  return database;
}

function list(
  database: Database,
  project: string | null,
  worktree: string | null,
  branch: string | null,
) {
  if (!project || !worktree) return { conversations: [], hiddenConversations: [] };
  const conversations = database
    .query("SELECT * FROM conversations WHERE project = ? AND worktree = ? ORDER BY updated_at")
    .all(project, worktree)
    .map((row) => parseRow(row as Record<string, unknown>))
    .filter((item) => item.branch === branch);
  return {
    conversations: conversations.filter((item) => !item.hidden).map(publicConversation),
    hiddenConversations: conversations.filter((item) => item.hidden).map(publicConversation),
  };
}

function get(database: Database, id: string) {
  const row = database.query("SELECT * FROM conversations WHERE id = ?").get(id) as Record<
    string,
    unknown
  > | null;
  return row ? parseRow(row) : undefined;
}

function save(database: Database, conversation: Conversation) {
  database
    .query(
      `INSERT INTO conversations
       (id, project, project_path, project_identity, worktree, branch, directory, directory_identity, native_session_id, active_prompt_id, hidden, status, messages, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET project_path = excluded.project_path,
       project_identity = excluded.project_identity, directory_identity = excluded.directory_identity,
       native_session_id = excluded.native_session_id, active_prompt_id = excluded.active_prompt_id,
       status = excluded.status, messages = excluded.messages, updated_at = excluded.updated_at`,
    )
    .run(
      conversation.id,
      conversation.project,
      conversation.projectPath,
      conversation.projectIdentity,
      conversation.worktree,
      conversation.branch,
      conversation.directory,
      conversation.directoryIdentity,
      conversation.nativeSessionID,
      conversation.activePromptID,
      conversation.hidden ? 1 : 0,
      conversation.status,
      JSON.stringify(conversation.messages),
      conversation.updatedAt,
    );
}

function saveVisibility(database: Database, conversation: Conversation) {
  database
    .query("UPDATE conversations SET hidden = ? WHERE id = ?")
    .run(conversation.hidden ? 1 : 0, conversation.id);
}

function parseRow(row: Record<string, unknown>): Conversation {
  return {
    id: String(row.id),
    project: String(row.project),
    projectPath: String(row.project_path ?? ""),
    projectIdentity: String(row.project_identity ?? ""),
    worktree: String(row.worktree),
    branch: row.branch === null ? null : String(row.branch),
    directory: String(row.directory),
    directoryIdentity: String(row.directory_identity ?? ""),
    nativeSessionID: row.native_session_id === null ? null : String(row.native_session_id),
    activePromptID: row.active_prompt_id === null ? null : String(row.active_prompt_id),
    hidden: Number(row.hidden ?? 0) !== 0,
    status: row.status as Conversation["status"],
    messages: JSON.parse(String(row.messages)) as StoredMessage[],
    updatedAt: Number(row.updated_at),
  };
}

function sameScope(conversation: Conversation, scope: Scope) {
  return (
    conversation.project === scope.project &&
    conversation.worktree === scope.worktree &&
    conversation.branch === scope.branch
  );
}

function publicConversation({
  directory: _directory,
  projectPath: _projectPath,
  projectIdentity: _projectIdentity,
  directoryIdentity: _directoryIdentity,
  nativeSessionID: _nativeSessionID,
  activePromptID: _activePromptID,
  ...conversation
}: Conversation) {
  return conversation;
}

function parseScope(body: Record<string, unknown>): Scope {
  if (
    typeof body.project !== "string" ||
    typeof body.worktree !== "string" ||
    !(typeof body.branch === "string" || body.branch === null)
  )
    throw new Error("A project, worktree, and branch are required.");
  return { project: body.project, worktree: body.worktree, branch: body.branch };
}

async function readBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 32_768) throw new Error("Request body is too large.");
    chunks.push(Buffer.from(chunk));
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid request body.");
  return value as Record<string, unknown>;
}

function sameOrigin(request: IncomingMessage) {
  const host = request.headers.host?.toLowerCase();
  const origin = request.headers.origin;
  const site = request.headers["sec-fetch-site"];
  const hostname = host?.startsWith("[") ? host.slice(1, host.indexOf("]")) : host?.split(":")[0];
  return (
    !!host &&
    !!hostname &&
    isAllowedTerminalHost(hostname) &&
    (!origin || ["http", "https"].some((scheme) => origin === `${scheme}://${host}`)) &&
    (!site || site === "same-origin")
  );
}

function respond(response: ServerResponse, status: number, body: object) {
  response.statusCode = status;
  response.end(JSON.stringify(body));
}

function acquireAction(actions: Set<string>, id: string) {
  if (actions.has(id)) return false;
  actions.add(id);
  return true;
}

function releaseAction(actions: Set<string>, id: string) {
  actions.delete(id);
}
