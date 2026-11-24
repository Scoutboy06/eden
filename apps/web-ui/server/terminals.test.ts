import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { WebSocket } from "ws";

import { createTerminalServer } from "./terminals";

const execute = promisify(execFile);
const temporaryDirectories: string[] = [];
const servers: ReturnType<typeof createTerminalServer>[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) server.close();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test("starts a host PTY only from the registered project's live worktree and multiplexes viewers", async () => {
  if (process.platform === "win32") return;
  const root = await mkdtemp(join(tmpdir(), "eden-terminal-"));
  temporaryDirectories.push(root);
  const repository = join(root, "checkout");
  await execute("git", ["init", repository]);
  await execute("git", [
    "-C",
    repository,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "--allow-empty",
    "-m",
    "initial",
  ]);
  const branch = (
    await execute("git", ["-C", repository, "branch", "--show-current"])
  ).stdout.trim();
  const server = createTerminalServer({
    readProjects: async () => ({ project: { name: "Project", path: repository } }),
  });
  servers.push(server);
  const http = createServer();
  http.on("upgrade", (request, socket, head) => {
    if (!server.upgrade(request, socket, head)) socket.destroy();
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const port = (http.address() as { port: number }).port;
  const address = `http://127.0.0.1:${port}`;
  await expectWebSocketRejected(
    new WebSocket(`${address.replace("http", "ws")}/api/terminals/socket`, {
      origin: "http://evil.example",
    }),
  );
  const socket = new WebSocket(
    `${address.replace("http", "ws")}/api/terminals/socket?clientId=terminal-test-client-0001`,
    { origin: address },
  );
  const received: Record<string, unknown>[] = [];
  socket.on("message", (data) =>
    received.push(JSON.parse(data.toString()) as Record<string, unknown>),
  );
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  socket.send(
    JSON.stringify({
      type: "create",
      project: "project",
      worktree: "checkout",
      branch,
      cwd: tmpdir(),
      executable: "/bin/false",
      cols: 80,
      rows: 24,
    }),
  );
  const created = await waitFor(received, "created");
  const sessionId = String(created.sessionId);
  socket.send(
    JSON.stringify({
      type: "input",
      sessionId,
      data: btoa("printf 'EDEN_PTY_OK\\n'; printf 'WORKDIR_MARKER:%s\\n' \"$PWD\"\n"),
    }),
  );
  const output = await waitForOutput(received, "EDEN_PTY_OK", `WORKDIR_MARKER:${repository}`);
  expect(output).toContain(repository);

  const viewer = new WebSocket(
    `${address.replace("http", "ws")}/api/terminals/socket?clientId=terminal-viewer-client-0002`,
    { origin: address },
  );
  const viewed: Record<string, unknown>[] = [];
  viewer.on("message", (data) =>
    viewed.push(JSON.parse(data.toString()) as Record<string, unknown>),
  );
  await new Promise<void>((resolve, reject) => {
    viewer.once("open", resolve);
    viewer.once("error", reject);
  });
  viewer.send(JSON.stringify({ type: "list", project: "project", worktree: "checkout", branch }));
  expect(await waitFor(viewed, "sessions")).toMatchObject({ items: [{ id: sessionId }] });
  socket.send(
    JSON.stringify({
      type: "create",
      project: "project",
      worktree: "checkout",
      branch,
      requestId: "second",
    }),
  );
  const second = await waitFor(received, "created", (message) => message.requestId === "second");
  const secondId = String(second.sessionId);
  expect(
    await waitFor(viewed, "sessions", ({ items }) => Array.isArray(items) && items.length === 2),
  ).toMatchObject({ items: [{ id: sessionId }, { id: secondId }] });
  viewer.send(JSON.stringify({ type: "end", sessionId: secondId }));
  expect(
    await waitFor(
      viewed,
      "sessions",
      ({ items }) =>
        Array.isArray(items) &&
        items.length === 1 &&
        viewed.filter((message) => message.type === "sessions").length >= 3,
    ),
  ).toMatchObject({ items: [{ id: sessionId }] });
  viewer.send(JSON.stringify({ type: "attach", sessionId }));
  const attached = await waitFor(viewed, "attached");
  expect(attached.controller).toBe("terminal-test-client-0001");
  expect(attached.screen).toContain("EDEN_PTY_OK");
  viewer.send(JSON.stringify({ type: "take-control", sessionId }));
  expect(await waitFor(viewed, "state")).toMatchObject({
    controller: "terminal-viewer-client-0002",
  });
  viewer.send(
    JSON.stringify({
      type: "input",
      sessionId,
      data: btoa("printf 'TAKEOVER_MARKER:%s\\n' 'CONTROLLED'\n"),
    }),
  );
  expect(await waitForOutput(received, "TAKEOVER_MARKER:CONTROLLED")).toContain(
    "TAKEOVER_MARKER:CONTROLLED",
  );
  socket.send(
    JSON.stringify({
      type: "input",
      sessionId,
      data: btoa("printf 'UNAUTHORIZED_CONTROL'\n"),
    }),
  );
  await Bun.sleep(50);
  expect(await waitForOutput(received, "TAKEOVER_MARKER:CONTROLLED")).not.toContain(
    "UNAUTHORIZED_CONTROL",
  );
  viewer.send(JSON.stringify({ type: "resize", sessionId, cols: 91, rows: 33 }));
  expect(await waitFor(received, "resize")).toMatchObject({ cols: 91, rows: 33 });
  viewer.send(
    JSON.stringify({
      type: "input",
      sessionId,
      data: btoa("sleep 0.2; printf 'UNATTENDED_SCREEN_MARKER\\n'\n"),
    }),
  );
  socket.close();
  viewer.close();
  await Bun.sleep(450);
  const reconnected = new WebSocket(
    `${address.replace("http", "ws")}/api/terminals/socket?clientId=terminal-viewer-client-0002`,
    { origin: address },
  );
  const reconnectedMessages: Record<string, unknown>[] = [];
  reconnected.on("message", (data) =>
    reconnectedMessages.push(JSON.parse(data.toString()) as Record<string, unknown>),
  );
  await new Promise<void>((resolve, reject) => {
    reconnected.once("open", resolve);
    reconnected.once("error", reject);
  });
  reconnected.send(JSON.stringify({ type: "attach", sessionId }));
  const reattached = await waitFor(reconnectedMessages, "attached");
  expect(reattached.controller).toBe("terminal-viewer-client-0002");
  expect(reattached.screen).toContain("UNATTENDED_SCREEN_MARKER");
  reconnected.send(JSON.stringify({ type: "end", sessionId }));
  await waitFor(reconnectedMessages, "ended");
  reconnected.close();
  http.close();
});

async function waitFor(
  messages: Record<string, unknown>[],
  type: string,
  match: (message: Record<string, unknown>) => boolean = () => true,
) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5000) {
    const found = messages.find((message) => message.type === type && match(message));
    if (found) return found;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for terminal message ${type}`);
}

async function waitForOutput(messages: Record<string, unknown>[], ...values: string[]) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5000) {
    const output = messages
      .filter((item) => item.type === "output")
      .map((message) => atob(String(message.data)))
      .join("");
    if (values.every((value) => output.includes(value))) return output;
    await Bun.sleep(10);
  }
  const output = messages
    .filter((item) => item.type === "output")
    .map((message) => atob(String(message.data)))
    .join("");
  throw new Error(
    `Timed out waiting for terminal output ${values.join(" and ")}: ${output.slice(-500)}`,
  );
}

async function expectWebSocketRejected(socket: WebSocket) {
  await new Promise<void>((resolve, reject) => {
    socket.once("error", resolve);
    socket.once("open", () => reject(new Error("Cross-origin WebSocket unexpectedly opened")));
  });
}
