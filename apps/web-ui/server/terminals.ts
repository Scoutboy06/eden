import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { IncomingMessage } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import HeadlessTerminalPackage from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";

import { GitModule } from "../../../src/modules/git/git.module";

const { Terminal: HeadlessTerminal } = HeadlessTerminalPackage;

const outputLimit = 256 * 1024;
const screenLimit = 48 * 1024;
const reconnectGraceMs = 5000;
const sessionLimit = 32;
const clientLimit = 8;

type TerminalSession = {
  id: string;
  project: string;
  worktree: string;
  branch: string | null;
  process: ReturnType<typeof Bun.spawn>;
  screenTerminal: InstanceType<typeof HeadlessTerminal>;
  clients: Map<WebSocket, string>;
  controller: string | null;
  graceTimer?: ReturnType<typeof setTimeout>;
  screen: string;
  cols: number;
  rows: number;
};

type TerminalScope = { project: string; worktree: string; branch: string | null };

export type TerminalDependencies = {
  readProjects: () => Promise<Record<string, { name: string; path: string }>>;
  worktrees?: typeof GitModule.worktrees;
  spawn?: typeof Bun.spawn;
};

export function createTerminalServer(dependencies: TerminalDependencies) {
  const sessions = new Map<string, TerminalSession>();
  const watches = new Map<WebSocket, TerminalScope>();
  const publish = (scope: TerminalScope) => {
    for (const [socket, watch] of watches) {
      if (sameScope(scope, watch)) listSessions(socket, watch, sessions);
    }
  };
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
    socket.on("message", (raw) => {
      const text = raw.toString();
      if (text.length > 64 * 1024) return socket.close(1009, "Message too large");
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(text) as Record<string, unknown>;
      } catch {
        return socket.close(1003, "Invalid message");
      }
      if (!message || typeof message !== "object") return;
      if (message.type === "list") {
        const scope = terminalScope(message);
        watches.set(socket, scope);
        return listSessions(socket, scope, sessions);
      }
      if (message.type === "unwatch") {
        watches.delete(socket);
        return;
      }
      if (message.type === "create") {
        void createSession(socket, clientId, joined, message, sessions, dependencies, publish);
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
      server.close();
      for (const session of sessions.values()) endSession(session, sessions);
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
) {
  const items = [...sessions.values()]
    .filter((session) => sameScope(session, scope))
    .map(({ id }) => ({ id }));
  send(socket, { type: "sessions", ...scope, items });
}

async function createSession(
  socket: WebSocket,
  clientId: string,
  joined: Set<string>,
  message: Record<string, unknown>,
  sessions: Map<string, TerminalSession>,
  dependencies: TerminalDependencies,
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
    sessions.set(session.id, session);
    joined.add(session.id);
    session.clients.set(socket, clientId);
    send(socket, {
      type: "created",
      requestId: message.requestId,
      sessionId: session.id,
      controller: clientId,
      cols: session.cols,
      rows: session.rows,
    });
    publish(session);
    session.process.exited.then((code) => {
      broadcast(session, { type: "exit", sessionId: session.id, code });
      endSession(session, sessions, false);
      publish(session);
    });
  } catch {
    send(socket, {
      type: "error",
      requestId: message.requestId,
      error: "Could not start a terminal for that project worktree.",
    });
  }
}

async function startSession(
  message: Record<string, unknown>,
  clientId: string,
  dependencies: TerminalDependencies,
): Promise<TerminalSession> {
  const projectKey = typeof message.project === "string" ? message.project : "";
  const name = typeof message.worktree === "string" ? message.worktree : "";
  const projects = await dependencies.readProjects();
  const project = Object.hasOwn(projects, projectKey) ? projects[projectKey] : undefined;
  if (!project || !name || name.length > 255) throw new Error("Project or worktree not found.");
  const branch = typeof message.branch === "string" ? message.branch : null;
  const worktrees = await (dependencies.worktrees ?? GitModule.worktrees)(project.path);
  const matches = worktrees.filter(
    (worktree) => worktree.path.split(/[\\/]/).at(-1) === name && worktree.branch === branch,
  );
  const match = matches.length === 1 ? matches[0] : undefined;
  if (!match || !isAbsolute(match.path)) throw new Error("Worktree not found.");
  const cwd = await realpath(match.path);
  const cols = dimension(message.cols, 120);
  const rows = dimension(message.rows, 32);
  const screenTerminal = new HeadlessTerminal({
    cols,
    rows,
    scrollback: 0,
    allowProposedApi: true,
  });
  const screenSerializer = new SerializeAddon();
  screenTerminal.loadAddon(screenSerializer);
  let session!: TerminalSession;
  const shell =
    process.platform === "win32"
      ? (process.env.COMSPEC ?? "C:\\Windows\\System32\\cmd.exe")
      : (process.env.SHELL ?? "/bin/bash");
  const spawn = dependencies.spawn ?? Bun.spawn;
  const child = spawn([shell], {
    cwd,
    env: { ...process.env, TERM: "xterm-256color" },
    terminal: {
      cols,
      rows,
      name: "xterm-256color",
      data: (_terminal, data) => {
        if (!session) return;
        const chunk = Buffer.from(data).toString("base64");
        screenTerminal.write(data, () => {
          const snapshot = screenSerializer.serialize({ scrollback: 0 });
          if (snapshot.length <= screenLimit) session.screen = snapshot;
          for (const client of session.clients.keys())
            send(client, { type: "output", sessionId: session.id, data: chunk });
        });
      },
    },
  });
  session = {
    id: randomUUID(),
    project: projectKey,
    worktree: name,
    branch,
    process: child,
    screenTerminal,
    clients: new Map(),
    controller: clientId,
    screen: "",
    cols,
    rows,
  };
  return session;
}

function handleExistingSessionMessage(
  socket: WebSocket,
  clientId: string,
  joined: Set<string>,
  message: Record<string, unknown>,
  sessions: Map<string, TerminalSession>,
  watch: TerminalScope | undefined,
  publish: (scope: TerminalScope) => void,
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
    endSession(session, sessions);
    publish(session);
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
  session.process.terminal?.write(Buffer.from(message.data, "base64"));
}

function resizeSession(
  session: TerminalSession,
  clientId: string,
  message: Record<string, unknown>,
) {
  if (session.controller !== clientId) return;
  session.cols = dimension(message.cols, 120);
  session.rows = dimension(message.rows, 32);
  session.process.terminal?.resize(session.cols, session.rows);
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

function broadcast(session: TerminalSession, message: object) {
  for (const socket of session.clients.keys()) send(socket, message);
}

function endSession(session: TerminalSession, sessions: Map<string, TerminalSession>, kill = true) {
  if (!sessions.has(session.id)) return;
  sessions.delete(session.id);
  if (session.graceTimer) clearTimeout(session.graceTimer);
  if (kill) session.process.kill();
  session.process.terminal?.close();
  session.screenTerminal.dispose();
  broadcast(session, { type: "ended", sessionId: session.id });
  session.clients.clear();
}
