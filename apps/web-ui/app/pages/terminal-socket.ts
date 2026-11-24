import { claimTerminalClientId } from "@/pages/terminal-client-id";

type TerminalMessage = Record<string, unknown> & { type: string };

export type TerminalMessageListener = (message: TerminalMessage) => void;

const listeners = new Set<TerminalMessageListener>();
let socket: WebSocket | undefined;
let reconnectTimer: number | undefined;
let closed = false;
let connecting = false;
let clientIdentity: Promise<string> | undefined;
let clientId: string | undefined;

export function terminalClientId() {
  return clientId;
}

export function subscribeTerminals(listener: TerminalMessageListener) {
  listeners.add(listener);
  if (socket?.readyState === WebSocket.OPEN) listener({ type: "connected" });
  else connect();
  return () => listeners.delete(listener);
}

export function sendTerminal(message: object) {
  if (socket?.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(message));
  return true;
}

async function connect() {
  if (
    closed ||
    connecting ||
    !listeners.size ||
    socket?.readyState === WebSocket.OPEN ||
    socket?.readyState === WebSocket.CONNECTING
  )
    return;
  connecting = true;
  clientIdentity ??= claimTerminalClientId();
  clientId = await clientIdentity;
  connecting = false;
  if (closed || !listeners.size) return;
  const connection = new WebSocket(
    `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/terminals/socket?clientId=${encodeURIComponent(clientId)}`,
  );
  socket = connection;
  connection.onopen = () => notify({ type: "connected" });
  connection.onmessage = (event) => {
    notify(JSON.parse(String(event.data)) as TerminalMessage);
  };
  connection.onclose = () => {
    if (socket !== connection) return;
    socket = undefined;
    notify({ type: "disconnected" });
    reconnectTimer = window.setTimeout(connect, 1000);
  };
  connection.onerror = () => connection.close();
}

function notify(message: TerminalMessage) {
  for (const listener of listeners) listener(message);
}

window.addEventListener("beforeunload", () => {
  closed = true;
  if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
  socket?.close();
});
