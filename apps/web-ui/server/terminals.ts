import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { IncomingMessage } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import HeadlessTerminalPackage from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";

import { GitModule } from "../../../src/modules/git/git.module";
import { agentHarnesses, isAgentHarness, type AgentHarness } from "../shared/agent-harnesses";
import type { RuntimeTerminal, TerminalAttachment, TerminalRuntime } from "./terminal-runtime";

const { Terminal: HeadlessTerminal } = HeadlessTerminalPackage;

const outputLimit = 256 * 1024;
const screenLimit = 48 * 1024;
const reconnectGraceMs = 5000;
const sessionLimit = 32;
const clientLimit = 8;

type TerminalSession = RuntimeTerminal & {
  attachment: TerminalAttachment;
  screenTerminal: InstanceType<typeof HeadlessTerminal>;
  clients: Map<WebSocket, string>;
  controller: string | null;
  graceTimer?: ReturnType<typeof setTimeout>;
  screen: string;
};

export type TerminalScope = { project: string; worktree: string; branch: string | null };

export type TerminalDependencies = {
  readProjects: () => Promise<Record<string, { name: string; path: string }>>;
  worktrees?: typeof GitModule.worktrees;
  runtime: TerminalRuntime;
  findExecutable?: (name: string) => string | null;
};

class HarnessLaunchError extends Error {}

export function createTerminalServer(dependencies: TerminalDependencies) {
  const sessions = new Map<string, TerminalSession>();
  const { runtime } = dependencies;
  const watches = new Map<WebSocket, TerminalScope>();
  let closed = false;
  let recovery: Promise<void> | undefined;
  const findExecutable = dependencies.findExecutable ?? ((name) => Bun.which(name));
  const publish = (scope: TerminalScope) => {
    for (const [socket, watch] of watches) {
      if (sameScope(scope, watch)) listSessions(socket, watch, sessions);
    }
  };
  function register(session: TerminalSession) {
    sessions.set(session.id, session);
    void session.attachment.closed.then(({ code, exited }) => {
      if (sessions.get(session.id) !== session) return;
      if (exited) broadcast(session, { type: "exit", sessionId: session.id, code });
      else recovery = undefined;
      removeSession(session, sessions);
      publish(session);
    });
  }

  function recover() {
    if (!runtime.capabilities.recoverSessions) return Promise.resolve();
    return (recovery ??= recoverSessions(dependencies, sessions, (session) => {
      if (closed) return session.attachment.detach();
      register(session);
      publish(session);
    }).catch((error: unknown) => {
      recovery = undefined;
      throw error;
    }));
  }
  void recover().catch(() => {});
  const server = new WebSocketServer({
    noServer: true,
    maxPayload: 192 * 1024,
    perMessageDeflate: false,
  });

  server.on("connection", (socket, request) => {
    const requestedClientId = new URL(request.url ?? "/", "http://eden.local").searchParams.get(
      "clientId",
    );
    const clientId =
      requestedClientId && /^[\w-]{16,80}$/.test(requestedClientId)
        ? requestedClientId
        : randomUUID();
    const joined = new Set<string>();
    socket.on("message", async (raw) => {
      const text = raw.toString();
      if (text.length > 64 * 1024) return socket.close(1009, "Message too large");
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(text) as Record<string, unknown>;
      } catch {
        return socket.close(1003, "Invalid message");
      }
      if (!message || typeof message !== "object") return;
      try {
        await recover();
      } catch (error) {
        return send(socket, {
          type: "runtime-error",
          error: error instanceof Error ? error.message : "Terminal backend unavailable.",
        });
      }
      if (closed || socket.readyState !== WebSocket.OPEN) return;
      if (message.type === "list") {
        const scope = terminalScope(message);
        watches.set(socket, scope);
        const availableHarnesses = Object.keys(agentHarnesses)
          .filter(isAgentHarness)
          .filter((harness) => findExecutable(agentHarnesses[harness].executable));
        return listSessions(socket, scope, sessions, availableHarnesses);
      }
      if (message.type === "unwatch") {
        watches.delete(socket);
        return;
      }
      if (message.type === "create") {
        void createSession(
          socket,
          clientId,
          joined,
          message,
          sessions,
          dependencies,
          (session) => {
            if (closed) {
              if (!runtime.capabilities.recoverSessions) void runtime.stop(session).catch(() => {});
              session.attachment.detach();
              session.screenTerminal.dispose();
              return false;
            }
            register(session);
            return true;
          },
          publish,
        );
        return;
      }
      handleExistingSessionMessage(
        socket,
        clientId,
        joined,
        message,
        sessions,
        watches.get(socket),
        publish,
        runtime,
      );
    });
    socket.on("close", () => {
      watches.delete(socket);
      for (const id of joined) {
        const session = sessions.get(id);
        if (!session) continue;
        session.clients.delete(socket);
        if (session.controller === clientId && ![...session.clients.values()].includes(clientId)) {
          session.graceTimer = setTimeout(() => {
            if (session.controller === clientId) session.controller = null;
            broadcast(session, { type: "state", sessionId: id, controller: session.controller });
          }, reconnectGraceMs);
          session.graceTimer.unref?.();
        }
      }
    });
  });

  return {
    upgrade(request: IncomingMessage, socket: import("node:stream").Duplex, head: Buffer) {
      if (request.url?.split("?")[0] !== "/api/terminals/socket" || !safeRequest(request))
        return false;
      server.handleUpgrade(request, socket, head, (webSocket) =>
        server.emit("connection", webSocket, request),
      );
      return true;
    },
    close() {
      if (closed) return;
      closed = true;
      for (const socket of server.clients) socket.terminate();
      server.close();
      for (const session of sessions.values()) {
        if (!runtime.capabilities.recoverSessions) void runtime.stop(session).catch(() => {});
        removeSession(session, sessions);
      }
    },
    sessions,
  };
}

function terminalScope(message: Record<string, unknown>): TerminalScope {
  return {
    project: typeof message.project === "string" ? message.project : "",
    worktree: typeof message.worktree === "string" ? message.worktree : "",
    branch: typeof message.branch === "string" ? message.branch : null,
  };
}

function sameScope(left: TerminalScope, right: TerminalScope) {
  return (
    left.project === right.project &&
    left.worktree === right.worktree &&
    left.branch === right.branch
  );
}

function listSessions(
  socket: WebSocket,
  scope: TerminalScope,
  sessions: Map<string, TerminalSession>,
  availableHarnesses?: AgentHarness[],
) {
  const items = [...sessions.values()]
    .filter((session) => sameScope(session, scope))
    .map(({ id, harness }) => ({ id, harness }));
  send(socket, { type: "sessions", ...scope, items, availableHarnesses });
}

async function createSession(
  socket: WebSocket,
  clientId: string,
  joined: Set<string>,
  message: Record<string, unknown>,
  sessions: Map<string, TerminalSession>,
  dependencies: TerminalDependencies,
  register: (session: TerminalSession) => boolean,
  publish: (scope: TerminalScope) => void,
) {
  if (sessions.size >= sessionLimit)
    return send(socket, {
      type: "error",
      requestId: message.requestId,
      error: "Terminal session limit reached.",
    });
  try {
    const session = await startSession(message, clientId, dependencies);
    if (!register(session)) return;
    joined.add(session.id);
    session.clients.set(socket, clientId);
    send(socket, {
      type: "created",
      requestId: message.requestId,
      sessionId: session.id,
      harness: session.harness,
      controller: clientId,
      cols: session.cols,
      rows: session.rows,
    });
    publish(session);
  } catch (error) {
    send(socket, {
      type: "error",
      requestId: message.requestId,
      error:
        error instanceof HarnessLaunchError
          ? error.message
          : "Could not start a terminal for that project worktree.",
    });
  }
}

async function startSession(
  message: Record<string, unknown>,
  clientId: string,
  dependencies: TerminalDependencies,
): Promise<TerminalSession> {
  const scope = terminalScope(message);
  const cwd = await resolveWorktree(scope, dependencies);
  const { harness, executable } = terminalProgram(message.harness, dependencies.findExecutable);
  const terminal = await dependencies.runtime.start(
    {
      ...scope,
      id: randomUUID(),
      cwd,
      harness,
      cols: dimension(message.cols, 120),
      rows: dimension(message.rows, 32),
    },
    executable,
  );
  try {
    return await attachRuntime(terminal, clientId, dependencies.runtime);
  } catch (error) {
    await dependencies.runtime.stop(terminal).catch(() => {});
    throw error;
  }
}

export async function resolveWorktree(
  { project: projectKey, worktree: name, branch }: TerminalScope,
  dependencies: Pick<TerminalDependencies, "readProjects" | "worktrees">,
) {
  const projects = await dependencies.readProjects();
  const project = Object.hasOwn(projects, projectKey) ? projects[projectKey] : undefined;
  if (!project || !name || name.length > 255) throw new Error("Project or worktree not found.");
  const worktrees = await (dependencies.worktrees ?? GitModule.worktrees)(project.path);
  const matches = worktrees.filter(
    (worktree) => worktree.path.split(/[\\/]/).at(-1) === name && worktree.branch === branch,
  );
  const match = matches.length === 1 ? matches[0] : undefined;
  if (!match || !isAbsolute(match.path)) throw new Error("Worktree not found.");
  return realpath(match.path);
}

async function recoverSessions(
  dependencies: TerminalDependencies,
  sessions: Map<string, TerminalSession>,
  register: (session: TerminalSession) => void,
) {
  for (const terminal of await dependencies.runtime.discover()) {
    if (sessions.has(terminal.id)) continue;
    const cwd = await resolveWorktree(terminal, dependencies).catch(() => null);
    if (cwd !== terminal.cwd) continue;
    const session = await attachRuntime(terminal, null, dependencies.runtime).catch(() => null);
    if (session) register(session);
  }
}

async function attachRuntime(
  terminal: RuntimeTerminal,
  controller: string | null,
  runtime: TerminalRuntime,
) {
  const { cols, rows } = terminal;
  const screenTerminal = new HeadlessTerminal({
    cols,
    rows,
    scrollback: 0,
    allowProposedApi: true,
  });
  const screenSerializer = new SerializeAddon();
  screenTerminal.loadAddon(screenSerializer);
  const state = {
    ...terminal,
    screenTerminal,
    clients: new Map<WebSocket, string>(),
    controller,
    screen: "",
  };
  try {
    const attachment = await runtime.attach(terminal, (data) => {
      const bytes = Uint8Array.from(data);
      screenTerminal.write(bytes, () => {
        const snapshot = screenSerializer.serialize({ scrollback: 0 });
        if (snapshot.length <= screenLimit) state.screen = snapshot;
        broadcast(state, {
          type: "output",
          sessionId: terminal.id,
          data: Buffer.from(bytes).toString("base64"),
        });
      });
    });
    await new Promise<void>((resolve) => screenTerminal.write("", resolve));
    return Object.assign(state, { attachment });
  } catch (error) {
    screenTerminal.dispose();
    throw error;
  }
}

function terminalProgram(
  requested: unknown,
  findExecutable = (name: string) => Bun.which(name),
): { executable: string; harness?: AgentHarness } {
  if (requested === undefined) {
    return {
      executable:
        process.platform === "win32"
          ? (process.env.COMSPEC ?? "C:\\Windows\\System32\\cmd.exe")
          : (process.env.SHELL ?? "/bin/bash"),
    };
  }
  if (!isAgentHarness(requested)) throw new HarnessLaunchError("Unknown agent harness.");
  const { executable, title } = agentHarnesses[requested];
  const path = findExecutable(executable);
  if (!path || !isAbsolute(path))
    throw new HarnessLaunchError(`${title} is not on the Eden server's PATH.`);
  return { executable: path, harness: requested };
}

function handleExistingSessionMessage(
  socket: WebSocket,
  clientId: string,
  joined: Set<string>,
  message: Record<string, unknown>,
  sessions: Map<string, TerminalSession>,
  watch: TerminalScope | undefined,
  publish: (scope: TerminalScope) => void,
  runtime: TerminalRuntime,
) {
  const id = typeof message.sessionId === "string" ? message.sessionId : "";
  const session = sessions.get(id);
  if (message.type === "attach" && session)
    return attachSession(socket, clientId, joined, message, session);
  if (message.type === "detach") {
    session?.clients.delete(socket);
    return;
  }
  if (
    message.type === "end" &&
    session &&
    (joined.has(id) || (watch && sameScope(session, watch)))
  ) {
    void runtime
      .stop(session)
      .then(() => {
        if (sessions.get(id) !== session) return;
        removeSession(session, sessions);
        publish(session);
      })
      .catch(() => send(socket, { type: "terminal-error", error: "Could not stop the terminal." }));
    return;
  }
  if (!session?.clients.has(socket)) return;
  switch (message.type) {
    case "take-control":
      takeControl(session, clientId);
      break;
    case "input":
      writeInput(session, clientId, message);
      break;
    case "resize":
      resizeSession(session, clientId, message);
      break;
  }
}

function attachSession(
  socket: WebSocket,
  clientId: string,
  joined: Set<string>,
  message: Record<string, unknown>,
  session: TerminalSession,
) {
  if (!session.clients.has(socket) && session.clients.size >= clientLimit)
    return send(socket, {
      type: "error",
      requestId: message.requestId,
      error: "Terminal viewer limit reached.",
    });
  if (session.graceTimer && session.controller === clientId) {
    clearTimeout(session.graceTimer);
    session.graceTimer = undefined;
  }
  session.clients.set(socket, clientId);
  joined.add(session.id);
  send(socket, {
    type: "attached",
    requestId: message.requestId,
    sessionId: session.id,
    controller: session.controller,
    cols: session.cols,
    rows: session.rows,
    screen: session.screen,
  });
}

function takeControl(session: TerminalSession, clientId: string) {
  if (session.graceTimer) clearTimeout(session.graceTimer);
  session.graceTimer = undefined;
  session.controller = clientId;
  broadcast(session, { type: "state", sessionId: session.id, controller: clientId });
}

function writeInput(session: TerminalSession, clientId: string, message: Record<string, unknown>) {
  if (
    session.controller !== clientId ||
    typeof message.data !== "string" ||
    message.data.length > 16_384
  )
    return;
  session.attachment.write(Buffer.from(message.data, "base64"));
}

function resizeSession(
  session: TerminalSession,
  clientId: string,
  message: Record<string, unknown>,
) {
  if (session.controller !== clientId) return;
  session.cols = dimension(message.cols, 120);
  session.rows = dimension(message.rows, 32);
  session.attachment.resize(session.cols, session.rows);
  session.screenTerminal.resize(session.cols, session.rows);
  broadcast(session, {
    type: "resize",
    sessionId: session.id,
    cols: session.cols,
    rows: session.rows,
  });
}

function safeRequest(request: IncomingMessage) {
  const host = request.headers.host?.toLowerCase() ?? "";
  const origin = request.headers.origin;
  if (!validHost(host)) return false;
  const scheme = "encrypted" in request.socket && request.socket.encrypted ? "https" : "http";
  return origin === `${scheme}://${host}`;
}

function validHost(host: string) {
  const hostname = host.startsWith("[")
    ? host.slice(1, host.indexOf("]"))
    : (host.split(":")[0] ?? "");
  return isAllowedTerminalHost(hostname);
}

export function isAllowedTerminalHost(hostname: string) {
  if (["localhost", "127.0.0.1", "::1"].includes(hostname)) return true;
  if (/^fd7a:115c:a1e0(?::[0-9a-f:]+)?$/i.test(hostname)) return true;
  const octets = hostname.split(".").map(Number);
  return (
    octets.length === 4 &&
    octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255) &&
    octets[0] === 100 &&
    octets[1]! >= 64 &&
    octets[1]! <= 127
  );
}

function dimension(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isInteger(value)
    ? Math.min(400, Math.max(2, value))
    : fallback;
}

function send(socket: WebSocket, message: object) {
  if (socket.readyState === WebSocket.OPEN && socket.bufferedAmount < outputLimit)
    socket.send(JSON.stringify(message));
}

function broadcast(session: Pick<TerminalSession, "clients">, message: object) {
  for (const socket of session.clients.keys()) send(socket, message);
}

function removeSession(session: TerminalSession, sessions: Map<string, TerminalSession>) {
  if (!sessions.has(session.id)) return;
  sessions.delete(session.id);
  if (session.graceTimer) clearTimeout(session.graceTimer);
  session.attachment.detach();
  session.screenTerminal.dispose();
  broadcast(session, { type: "ended", sessionId: session.id });
  session.clients.clear();
}
