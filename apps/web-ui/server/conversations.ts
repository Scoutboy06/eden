import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { realpath, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import type { OpenCodeConversationClient } from "../../../src/external/opencode/client";
import { GitModule } from "../../../src/modules/git/git.module";
import { createOpenCodeConversationClient } from "../../../src/external/opencode/client";
import { isAllowedTerminalHost, resolveWorktree } from "./terminals";
import { presentForm, validateFormAnswer } from "./conversation-forms";
import type { ConversationForm, ConversationMessage } from "../conversation-contract";

type Scope = { project: string; worktree: string; branch: string | null };
type StoredToolCall = {
  id: string;
  name: string;
  status: "running" | "completed" | "failed";
};
type StoredMessage = ConversationMessage;
type Approval = { id: string; action: string; resources: string[]; message?: string };
type Conversation = Scope & {
  id: string;
  projectPath: string;
  projectIdentity: string;
  directory: string;
  directoryIdentity: string;
  nativeSessionID: string | null;
  activePromptID: string | null;
  selectedModelKey: string | null;
  selectedModelLabel: string | null;
  hidden: boolean;
  status: "ready" | "active" | "blocked" | "incomplete";
  messages: StoredMessage[];
  updatedAt: number;
};
type Database = import("bun:sqlite").Database;
const databasePublishers = new WeakMap<Database, (scope: Scope) => void>();
const conversationSocketLimit = 32;
const conversationSocketBufferLimit = 256 * 1024;

export type ConversationDependencies = {
  readProjects: () => Promise<Record<string, { name: string; path: string }>>;
  client?: OpenCodeConversationClient;
  databasePath?: string;
  worktrees?: typeof GitModule.worktrees;
};
type ConversationReplyDependencies = {
  request: IncomingMessage;
  response: ServerResponse;
  database: Database;
  client: OpenCodeConversationClient;
  dependencies: ConversationDependencies;
  actions: Set<string>;
};

export function createConversationMiddleware(dependencies: ConversationDependencies) {
  const client = dependencies.client ?? createOpenCodeConversationClient();
  const actions = new Set<string>();
  let databasePromise: Promise<Database> | undefined;
  let recoveryStarted = false;
  const subscribers = new Map<WebSocket, Scope>();
  const sockets = new WebSocketServer({
    noServer: true,
    maxPayload: 32 * 1024,
    perMessageDeflate: false,
  });
  const publish = (scope: Scope) => {
    if (!databasePromise) return;
    void databasePromise.then((db) => {
      void sendSnapshot(db, scope, client, subscribers);
    });
  };
  const getDatabase = async () => {
    const db = await (databasePromise ??= openDatabase(dependencies.databasePath));
    databasePublishers.set(db, publish);
    return db;
  };
  const database = async () => {
    const connection = await getDatabase();
    if (!recoveryStarted) {
      recoveryStarted = true;
      void recoverConversations(connection, client, dependencies, actions).catch(() => {});
    }
    return connection;
  };

  const middleware = async (
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
      if (!(await handleCollectionRequest(request, response, url, db, client, dependencies))) {
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
  sockets.on("connection", (socket) => {
    socket.on("message", (raw) => {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(raw.toString()) as Record<string, unknown>;
      } catch {
        socket.close(1003, "Invalid message");
        return;
      }
      if (message.type === "unsubscribe") {
        subscribers.delete(socket);
        return;
      }
      if (message.type !== "subscribe") {
        socket.close(1008, "Invalid subscription");
        return;
      }
      void (async () => {
        const scope = parseScope(message);
        const projects = await dependencies.readProjects();
        await resolveWorktree(scope, {
          readProjects: async () => projects,
          worktrees: dependencies.worktrees,
        });
        subscribers.set(socket, scope);
        const db = await getDatabase();
        await sendSnapshot(db, scope, client, new Map([[socket, scope]]));
      })().catch(() => socket.close(1008, "Invalid worktree subscription"));
    });
    socket.on("close", () => subscribers.delete(socket));
  });
  return Object.assign(middleware, {
    upgrade(request: IncomingMessage, socket: import("node:stream").Duplex, head: Buffer) {
      if (
        request.url?.split("?")[0] !== "/api/conversations/socket" ||
        !sameConversationSocketOrigin(request) ||
        sockets.clients.size >= conversationSocketLimit
      )
        return false;
      sockets.handleUpgrade(request, socket, head, (webSocket) =>
        sockets.emit("connection", webSocket, request),
      );
      return true;
    },
    close() {
      for (const socket of sockets.clients) socket.terminate();
      sockets.close();
      subscribers.clear();
    },
  });
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
        if (event.type === "tool" && message) updateToolCall(message, event);
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
  client: OpenCodeConversationClient,
  dependencies: ConversationDependencies,
) {
  if (url.pathname !== "/api/conversations") return false;
  if (request.method === "GET") {
    const conversations = list(
      database,
      url.searchParams.get("project"),
      url.searchParams.get("worktree"),
      url.searchParams.get("branch") || null,
    );
    respond(response, 200, {
      conversations: await Promise.all(
        conversations.conversations.map((item) => withPending(item, client)),
      ),
      hiddenConversations: await Promise.all(
        conversations.hiddenConversations.map((item) => withPending(item, client)),
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
    selectedModelKey: null,
    selectedModelLabel: null,
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
  if (parts.length === 3 && request.method === "GET")
    return handleGetConversation(response, id, database, client);
  if (parts.length === 4 && parts[3] === "models" && request.method === "GET")
    return handleModelsRequest(response, id, database, client, dependencies);
  if (parts.length === 5 && request.method === "POST")
    return handleReplyRequest(
      request,
      response,
      parts,
      id,
      database,
      client,
      dependencies,
      actions,
    );
  return handleConversationAction(
    request,
    response,
    parts,
    id,
    database,
    client,
    dependencies,
    actions,
  );
}

async function handleGetConversation(
  response: ServerResponse,
  id: string,
  database: Database,
  client: OpenCodeConversationClient,
) {
  const conversation = get(database, id);
  if (!conversation) return respond(response, 404, { error: "Conversation not found." });
  return respond(response, 200, { conversation: await withPending(conversation, client) });
}

async function handleModelsRequest(
  response: ServerResponse,
  id: string,
  database: Database,
  client: OpenCodeConversationClient,
  dependencies: ConversationDependencies,
) {
  const conversation = get(database, id);
  if (!conversation) return respond(response, 404, { error: "Conversation not found." });
  if (!client.models) return respond(response, 503, { error: "Model selection is unavailable." });
  try {
    const { directory } = await resolveCurrentWorktree(conversation, dependencies);
    return respond(response, 200, { models: await client.models(directory) });
  } catch {
    return respond(response, 503, { error: "Could not load available OpenCode models." });
  }
}

function handleReplyRequest(
  request: IncomingMessage,
  response: ServerResponse,
  parts: string[],
  id: string,
  database: Database,
  client: OpenCodeConversationClient,
  dependencies: ConversationDependencies,
  actions: Set<string>,
) {
  const replyID = decodeURIComponent(parts[4]!);
  const input = {
    conversationID: id,
    replyID,
    request,
    response,
    database,
    client,
    dependencies,
    actions,
  };
  if (parts[3] === "permissions") return handlePermissionReply({ ...input, requestID: replyID });
  if (parts[3] === "forms") return handleFormReply({ ...input, formID: replyID });
  return respond(response, 405, { error: "Method not allowed." });
}

function handleConversationAction(
  request: IncomingMessage,
  response: ServerResponse,
  parts: string[],
  id: string,
  database: Database,
  client: OpenCodeConversationClient,
  dependencies: ConversationDependencies,
  actions: Set<string>,
) {
  if (parts.length !== 4 || request.method !== "POST")
    return respond(response, 405, { error: "Method not allowed." });
  if (parts[3] === "close" || parts[3] === "reopen")
    return handleVisibilityRequest(request, response, parts[3] === "close", id, database);
  if (parts[3] === "stop") return handleStopRequest(response, id, database, client, dependencies);
  if (parts[3] === "send")
    return handleSendRequest(request, response, id, database, client, dependencies, actions);
  return respond(response, 405, { error: "Method not allowed." });
}

async function handleVisibilityRequest(
  request: IncomingMessage,
  response: ServerResponse,
  hidden: boolean,
  id: string,
  database: Database,
) {
  const body = await readBody(request);
  const scope = parseScope(body);
  const conversation = get(database, id);
  if (!conversation) return respond(response, 404, { error: "Conversation not found." });
  if (!sameScope(conversation, scope))
    return respond(response, 404, { error: "Conversation not found in this worktree." });
  conversation.hidden = hidden;
  saveVisibility(database, conversation);
  return respond(response, 200, { conversation: publicConversation(conversation) });
}

async function handleStopRequest(
  response: ServerResponse,
  id: string,
  database: Database,
  client: OpenCodeConversationClient,
  dependencies: ConversationDependencies,
) {
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

async function handleSendRequest(
  request: IncomingMessage,
  response: ServerResponse,
  id: string,
  database: Database,
  client: OpenCodeConversationClient,
  dependencies: ConversationDependencies,
  actions: Set<string>,
) {
  if (!acquireAction(actions, id))
    return respond(response, 409, { error: "A conversation action is already in progress." });
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
    const model = await selectConversationModel(
      body,
      conversation,
      database,
      client,
      dependencies,
      response,
    );
    if (model === false) return;
    return await sendMessage(
      database,
      conversation,
      body.text.trim(),
      client,
      response,
      dependencies,
      actions,
      model,
    );
  } finally {
    releaseAction(actions, id);
  }
}

async function selectConversationModel(
  body: Record<string, unknown>,
  conversation: Conversation,
  database: Database,
  client: OpenCodeConversationClient,
  dependencies: ConversationDependencies,
  response: ServerResponse,
) {
  const modelKey = Object.hasOwn(body, "modelKey") ? body.modelKey : conversation.selectedModelKey;
  if (modelKey === null) {
    conversation.selectedModelKey = null;
    conversation.selectedModelLabel = null;
    save(database, conversation);
    return undefined;
  }
  if (typeof modelKey !== "string" || !client.models) {
    respond(response, 400, { error: "Choose an available OpenCode model." });
    return false;
  }
  const { directory } = await resolveCurrentWorktree(conversation, dependencies);
  const choices = await client.models(directory);
  const choice = choices.find(({ key }) => key === modelKey);
  if (!choice) {
    respond(response, 400, { error: "That OpenCode model is no longer available." });
    return false;
  }
  conversation.selectedModelKey = modelKey;
  conversation.selectedModelLabel = choice.group
    ? choice.name
    : `${choice.name} · ${choice.providerID}`;
  save(database, conversation);
  return { id: choice.id, providerID: choice.providerID };
}

async function handlePermissionReply({
  conversationID,
  requestID,
  request,
  response,
  database,
  client,
  dependencies,
  actions,
}: {
  conversationID: string;
  requestID: string;
} & ConversationReplyDependencies) {
  const context = await readReplyContext(request, response, database, conversationID);
  if (!context) return;
  if (
    context.body.decision !== "once" &&
    context.body.decision !== "always" &&
    context.body.decision !== "reject"
  )
    return respond(response, 400, { error: "Choose a native OpenCode permission response." });
  const actionID = `reply:${conversationID}`;
  if (!acquireAction(actions, actionID))
    return respond(response, 409, { error: "This permission request has already been answered." });
  try {
    if (
      !context.conversation.nativeSessionID ||
      (context.conversation.status !== "blocked" &&
        context.conversation.status !== "active" &&
        context.conversation.status !== "incomplete")
    )
      return respond(response, 409, { error: "This permission request is no longer pending." });
    const { directory } = await resolveCurrentWorktree(context.conversation, dependencies);
    const pending = await client.permissions(context.conversation.nativeSessionID, directory);
    if (!pending.some(({ id }) => id === requestID))
      return respond(response, 409, { error: "This permission request is no longer pending." });
    await client.replyPermission(
      context.conversation.nativeSessionID,
      directory,
      requestID,
      context.body.decision,
    );
    databasePublishers.get(database)?.(context.conversation);
    return respond(response, 200, {
      conversation: await withPending(context.conversation, client),
    });
  } catch {
    return respond(response, 409, { error: "This permission request is no longer pending." });
  } finally {
    releaseAction(actions, actionID);
  }
}

async function withPending(conversation: Conversation, client: OpenCodeConversationClient) {
  let approvals: Approval[] = [];
  let forms: ConversationForm[] = [];
  if (conversation.nativeSessionID && conversation.activePromptID) {
    try {
      approvals = await client.permissions(conversation.nativeSessionID, conversation.directory);
    } catch {}
    try {
      forms = (await client.forms(conversation.nativeSessionID, conversation.directory)).map(
        presentForm,
      );
    } catch {}
  }
  return {
    ...publicConversation(conversation),
    status: approvals.length || forms.length ? "blocked" : conversation.status,
    approvals,
    forms,
  };
}

async function sendSnapshot(
  database: Database,
  scope: Scope,
  client: OpenCodeConversationClient,
  subscribers: Map<WebSocket, Scope>,
) {
  const current = list(database, scope.project, scope.worktree, scope.branch);
  const present = async (conversation: Conversation) =>
    conversation.status === "blocked"
      ? withPending(conversation, client)
      : publicConversation(conversation);
  const [conversations, hiddenConversations] = await Promise.all([
    Promise.all(current.conversations.map(present)),
    Promise.all(current.hiddenConversations.map(present)),
  ]);
  const message = JSON.stringify({
    type: "snapshot",
    ...scope,
    conversations,
    hiddenConversations,
  });
  for (const [socket, watched] of subscribers) {
    if (
      watched.project !== scope.project ||
      watched.worktree !== scope.worktree ||
      watched.branch !== scope.branch ||
      socket.readyState !== WebSocket.OPEN
    )
      continue;
    if (socket.bufferedAmount >= conversationSocketBufferLimit) {
      subscribers.delete(socket);
      socket.close(1013, "Slow conversation subscriber");
    } else socket.send(message);
  }
}

async function readReplyContext(
  request: IncomingMessage,
  response: ServerResponse,
  database: Database,
  conversationID: string,
) {
  const conversation = get(database, conversationID);
  if (!conversation) {
    respond(response, 404, { error: "Conversation not found." });
    return null;
  }
  return { conversation, body: await readBody(request) };
}

async function handleFormReply({
  conversationID,
  formID,
  request,
  response,
  database,
  client,
  dependencies,
  actions,
}: {
  conversationID: string;
  formID: string;
} & ConversationReplyDependencies) {
  const context = await readReplyContext(request, response, database, conversationID);
  if (!context) return;
  const actionID = `reply:${conversationID}`;
  if (!acquireAction(actions, actionID))
    return respond(response, 409, { error: "This form is already being answered." });
  try {
    if (
      !context.conversation.nativeSessionID ||
      !context.conversation.activePromptID ||
      !["blocked", "active", "incomplete"].includes(context.conversation.status)
    )
      return respond(response, 409, { error: "This form is no longer pending." });
    const { directory } = await resolveCurrentWorktree(context.conversation, dependencies);
    const form = await client.form(context.conversation.nativeSessionID, directory, formID);
    if (
      form.sessionID !== context.conversation.nativeSessionID ||
      form.id !== formID ||
      form.state.status !== "pending"
    )
      return respond(response, 409, { error: "This form is no longer pending." });
    const presented = presentForm(form);
    if (presented.unsupported.length)
      return respond(response, 400, { error: "This form contains unsupported fields." });
    const answer = validateFormAnswer(presented, context.body.answer);
    await client.replyForm(context.conversation.nativeSessionID, directory, formID, answer);
    databasePublishers.get(database)?.(context.conversation);
    return respond(response, 200, {
      conversation: await withPending(context.conversation, client),
    });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "";
    if (message.startsWith("Invalid form answer:"))
      return respond(response, 400, { error: message });
    return respond(response, 409, { error: "This form is no longer pending or was rejected." });
  } finally {
    releaseAction(actions, actionID);
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
  model?: { id: string; providerID: string },
) {
  const attempt = { promptAttempted: false, appendedMessages: [] as StoredMessage[] };
  try {
    const { directory } = await resolveCurrentWorktree(conversation, dependencies);
    await client.prepare(directory);
    if (await reconcilePreviousTurn(database, conversation, directory, client, response, actions))
      return;
    if (await ensureNativeSession(conversation, directory, database, client, response)) return;
    return await submitPrompt(
      database,
      conversation,
      directory,
      text,
      client,
      response,
      attempt,
      model,
    );
  } catch {
    return failPrompt(database, conversation, attempt, response);
  }
}

async function reconcilePreviousTurn(
  database: Database,
  conversation: Conversation,
  directory: string,
  client: OpenCodeConversationClient,
  response: ServerResponse,
  actions: Set<string>,
) {
  if (!conversation.nativeSessionID || !conversation.activePromptID) return false;
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
    respond(response, 409, {
      error: "The previous OpenCode turn is still in progress.",
      conversation: publicConversation(conversation),
    });
    return true;
  }
  if (reconciled.reply === null) {
    respond(response, 409, {
      error: "The previous OpenCode turn could not be reconciled; it will not be replayed.",
      conversation: publicConversation(conversation),
    });
    return true;
  }
  updateAssistantReply(conversation, reconciled.reply);
  conversation.activePromptID = null;
  conversation.status = "ready";
  save(database, conversation);
  return false;
}

async function ensureNativeSession(
  conversation: Conversation,
  directory: string,
  database: Database,
  client: OpenCodeConversationClient,
  response: ServerResponse,
) {
  if (!conversation.nativeSessionID) {
    conversation.nativeSessionID = await client.create(directory);
    save(database, conversation);
    return false;
  }
  const state = await client.inspect(conversation.nativeSessionID, directory);
  if (!state.active) return false;
  respond(response, 409, {
    error: "The linked OpenCode session is busy.",
    conversation: publicConversation(conversation),
  });
  return true;
}

async function submitPrompt(
  database: Database,
  conversation: Conversation,
  directory: string,
  text: string,
  client: OpenCodeConversationClient,
  response: ServerResponse,
  attempt: { promptAttempted: boolean; appendedMessages: StoredMessage[] },
  model?: { id: string; providerID: string },
) {
  const promptID = `msg_${randomUUID().replaceAll("-", "")}`;
  const userMessage: StoredMessage = { role: "user", text, createdAt: Date.now() };
  const assistantMessage: StoredMessage = { role: "assistant", text: "", createdAt: Date.now() };
  attempt.appendedMessages = [userMessage, assistantMessage];
  conversation.messages.push(...attempt.appendedMessages);
  conversation.activePromptID = promptID;
  conversation.status = "active";
  save(database, conversation);

  const result = await client.send(
    conversation.nativeSessionID!,
    directory,
    promptID,
    text,
    (event) => {
      if (event.type === "attempting") attempt.promptAttempted = true;
      if (event.type === "accepted") conversation.activePromptID = event.userMessageID;
      if (event.type === "text") assistantMessage.text += event.delta;
      if (event.type === "tool") updateToolCall(assistantMessage, event);
      if (event.type === "blocked") conversation.status = "blocked";
      if (event.type === "settled") assistantMessage.text = event.reply;
      conversation.updatedAt = Date.now();
      save(database, conversation);
    },
    model,
  );
  assistantMessage.text = result.reply;
  conversation.status = "ready";
  conversation.activePromptID = null;
  conversation.updatedAt = Date.now();
  save(database, conversation);
  return respond(response, 200, { conversation: publicConversation(conversation) });
}

function failPrompt(
  database: Database,
  conversation: Conversation,
  attempt: { promptAttempted: boolean; appendedMessages: StoredMessage[] },
  response: ServerResponse,
) {
  if (conversation.activePromptID) {
    if (attempt.promptAttempted) {
      conversation.status = "incomplete";
    } else {
      conversation.messages = conversation.messages.filter(
        (message) => !attempt.appendedMessages.includes(message),
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

function updateToolCall(
  message: StoredMessage,
  call: { id: string; name: string; status: StoredToolCall["status"] },
) {
  if (!call.id || call.id.length > 200) return;
  const id = call.id;
  const tools = (message.tools ??= []);
  const existing = tools.find((tool) => tool.id === id);
  const name = /^[a-zA-Z0-9_.:-]{1,64}$/.test(call.name) ? call.name : "";
  if (existing) {
    if (name) existing.name = name;
    existing.status = call.status;
  } else if (tools.length < 100) {
    tools.push({ id, name: name || "tool", status: call.status });
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
       selected_model_key TEXT,
       selected_model_label TEXT,
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
  if (!columns.includes("selected_model_key"))
    database.exec("ALTER TABLE conversations ADD COLUMN selected_model_key TEXT");
  if (!columns.includes("selected_model_label"))
    database.exec("ALTER TABLE conversations ADD COLUMN selected_model_label TEXT");
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
    conversations: conversations.filter((item) => !item.hidden),
    hiddenConversations: conversations.filter((item) => item.hidden),
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
       (id, project, project_path, project_identity, worktree, branch, directory, directory_identity, native_session_id, active_prompt_id, selected_model_key, selected_model_label, hidden, status, messages, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET project_path = excluded.project_path,
       project_identity = excluded.project_identity, directory_identity = excluded.directory_identity,
       native_session_id = excluded.native_session_id, active_prompt_id = excluded.active_prompt_id,
        selected_model_key = excluded.selected_model_key,
        selected_model_label = excluded.selected_model_label,
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
      conversation.selectedModelKey,
      conversation.selectedModelLabel,
      conversation.hidden ? 1 : 0,
      conversation.status,
      JSON.stringify(conversation.messages),
      conversation.updatedAt,
    );
  databasePublishers.get(database)?.(conversation);
}

function saveVisibility(database: Database, conversation: Conversation) {
  database
    .query("UPDATE conversations SET hidden = ? WHERE id = ?")
    .run(conversation.hidden ? 1 : 0, conversation.id);
  databasePublishers.get(database)?.(conversation);
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
    selectedModelKey:
      row.selected_model_key === null || row.selected_model_key === undefined
        ? null
        : String(row.selected_model_key),
    selectedModelLabel:
      row.selected_model_label === null || row.selected_model_label === undefined
        ? null
        : String(row.selected_model_label),
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

function sameConversationSocketOrigin(request: IncomingMessage) {
  const host = request.headers.host?.toLowerCase();
  const scheme = "encrypted" in request.socket && request.socket.encrypted ? "https" : "http";
  return !!host && request.headers.origin === `${scheme}://${host}` && sameOrigin(request);
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
