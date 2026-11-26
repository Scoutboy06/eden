import { expect, test } from "bun:test";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { Endpoint } from "@opencode/client/service";
import { createOpenCodeConversationClient } from "./client";

test("uses refreshed service discovery and waits past prompt acceptance for delayed deltas and settlement", async () => {
  const servers: Server[] = [];
  const streams: ServerResponse[] = [];
  let messages: object[] = [];
  let selectedModel: unknown;
  let switchedBeforePrompt = false;
  let endpoint!: Endpoint;
  const server = createServer(async (request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    if (path === "/api/info") {
      response.setHeader("content-type", "application/json");
      return response.end(
        JSON.stringify({ version: "2.4.1", pid: 1, urls: [], paths: { tmp: "/tmp" } }),
      );
    }
    if (path === "/api/event") {
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      response.write('data: {"type":"server.connected","id":"connected","data":{}}\n\n');
      streams.push(response);
      return;
    }
    if (path === "/api/session/session/model") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      selectedModel = JSON.parse(Buffer.concat(chunks).toString()).model;
      response.statusCode = 204;
      response.end();
      return;
    }
    if (path === "/api/session/session/prompt") {
      switchedBeforePrompt = selectedModel !== undefined;
      messages = [
        {
          id: "user-1",
          sessionID: "session",
          time: { created: 10 },
          type: "user",
          payload: { text: "hello" },
          delivery: { status: "delivered" },
        },
      ];
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          data: {
            id: "user-1",
            sessionID: "session",
            time: { created: 10 },
            type: "user",
            payload: { text: "hello" },
            delivery: { status: "delivered" },
          },
        }),
      );
      setTimeout(() => {
        emit({
          type: "session.text.started",
          id: "started",
          created: 11,
          data: { sessionID: "session", assistantMessageID: "assistant-1", ordinal: 0 },
        });
        emit({
          type: "session.text.delta",
          id: "delta",
          created: 12,
          data: {
            sessionID: "session",
            assistantMessageID: "assistant-1",
            ordinal: 0,
            delta: "Hello",
          },
        });
      }, 25);
      setTimeout(() => {
        messages = [
          ...messages,
          {
            id: "assistant-1",
            type: "assistant",
            time: { created: 13, completed: 14 },
            agent: "build",
            model: { providerID: "mock", modelID: "mock" },
            content: [{ type: "text", text: "Hello there." }],
            finish: "stop",
          },
        ];
        emit({
          type: "session.execution.succeeded",
          id: "settled",
          created: 14,
          data: { sessionID: "session" },
        });
      }, 70);
      return;
    }
    if (path === "/api/session/session/message") {
      response.setHeader("content-type", "application/json");
      return response.end(JSON.stringify({ data: messages, cursor: {} }));
    }
    if (path === "/api/session/active") {
      response.setHeader("content-type", "application/json");
      return response.end(JSON.stringify({ data: {} }));
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ errors: [{ message: "Not found" }] }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  endpoint = { url: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
  const restartedServer = createServer(
    server.listeners("request")[0] as Parameters<typeof createServer>[0],
  );
  servers.push(restartedServer);
  await new Promise<void>((resolve) => restartedServer.listen(0, "127.0.0.1", resolve));

  const client = createOpenCodeConversationClient({ discover: async () => endpoint });
  await client.prepare("/tmp/worktree");
  endpoint = {
    url: `http://127.0.0.1:${(restartedServer.address() as { port: number }).port}`,
  };
  let accepted!: () => void;
  const wasAccepted = new Promise<void>((resolve) => {
    accepted = resolve;
  });
  let sendResolved = false;
  const sending = client
    .send(
      "session",
      "/tmp/worktree",
      "prompt-1",
      "hello",
      (event) => {
        if (event.type === "accepted") accepted();
      },
      { id: "mock", providerID: "mock" },
    )
    .then((result) => {
      sendResolved = true;
      return result;
    });
  try {
    await wasAccepted;
    expect(sendResolved).toBe(false);
    const result = await sending;
    expect(result.reply).toBe("Hello there.");
    expect(selectedModel).toEqual({ id: "mock", providerID: "mock" });
    expect(switchedBeforePrompt).toBe(true);
  } finally {
    for (const stream of streams) stream.end();
    for (const instance of servers) instance.close();
  }

  function emit(event: object) {
    for (const stream of streams) stream.write(`data: ${JSON.stringify(event)}\n\n`);
  }
});

test("event-stream EOF before delayed prompt acceptance is handled without an unhandled rejection", async () => {
  const clientModule = new URL("./client.ts", import.meta.url).href;
  const source = `
    import { createServer } from "node:http";
    import { createOpenCodeConversationClient } from ${JSON.stringify(clientModule)};

    const unhandled = [];
    process.on("unhandledRejection", (error) => unhandled.push(String(error)));
    const server = createServer((request, response) => {
      const path = new URL(request.url ?? "/", "http://localhost").pathname;
      if (path === "/api/info") {
        response.setHeader("content-type", "application/json");
        return response.end(JSON.stringify({ version: "2.4.1", pid: 1, urls: [], paths: { tmp: "/tmp" } }));
      }
      if (path === "/api/model/default") {
        response.setHeader("content-type", "application/json");
        return response.end(JSON.stringify({ data: {
          id: "mock", modelID: "mock", providerID: "mock", type: "chat", name: "Mock"
        } }));
      }
      if (path === "/api/session/session/model") {
        response.statusCode = 204;
        return response.end();
      }
      if (path === "/api/event") {
        response.writeHead(200, { "content-type": "text/event-stream", connection: "keep-alive" });
        response.write('data: {"type":"server.connected","id":"connected","data":{}}\\n\\n');
        return setTimeout(() => response.end(), 10);
      }
      if (path === "/api/session/session/prompt") {
        response.setHeader("content-type", "application/json");
        return setTimeout(() => response.end(JSON.stringify({ data: {
          id: "user-1", sessionID: "session", time: { created: 10 }, type: "user",
          payload: { text: "hello" }, delivery: { status: "delivered" }
        } })), 100);
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ errors: [{ message: "Not found" }] }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const endpoint = { url: "http://127.0.0.1:" + server.address().port };
    const client = createOpenCodeConversationClient({ discover: async () => endpoint });
    const watchdog = setTimeout(() => process.exit(7), 4000);
    let outcome = "";
    try {
      await client.send("session", "/tmp/worktree", "prompt-id", "hello", () => {});
      outcome = "unexpected-success";
    } catch (error) {
      outcome = String(error);
    }
    await Bun.sleep(30);
    clearTimeout(watchdog);
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    if (!outcome.includes("event stream ended before the turn settled")) {
      console.error("Unexpected send outcome:", outcome);
      process.exit(2);
    }
    if (unhandled.length) {
      console.error("Unhandled rejections:", unhandled.join(" | "));
      process.exit(3);
    }
    console.log("EOF handled; child remained live through delayed prompt acceptance.");
  `;
  const child = Bun.spawn([Bun.which("bun")!, "-e", source], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(exitCode).toBe(0);
  expect(stdout).toContain("child remained live");
  expect(stderr).toBe("");
});

test("resolves and switches to the worktree default before prompting", async () => {
  const servers: Server[] = [];
  const calls: string[] = [];
  let switchedModel: unknown;
  const server = createServer(async (request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    if (path === "/api/info") {
      response.setHeader("content-type", "application/json");
      return response.end(
        JSON.stringify({ version: "2.4.1", pid: 1, urls: [], paths: { tmp: "/tmp" } }),
      );
    }
    if (path === "/api/model/default") {
      calls.push("default");
      response.setHeader("content-type", "application/json");
      return response.end(
        JSON.stringify({
          data: {
            id: "free-default",
            modelID: "free-default",
            providerID: "opencode",
            type: "chat",
            name: "Free Default",
          },
        }),
      );
    }
    if (path === "/api/event") {
      response.writeHead(200, { "content-type": "text/event-stream", connection: "keep-alive" });
      response.write('data: {"type":"server.connected","id":"connected","data":{}}\n\n');
      return;
    }
    if (path === "/api/session/session/model") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      switchedModel = JSON.parse(Buffer.concat(chunks).toString()).model;
      calls.push("switch");
      response.statusCode = 204;
      return response.end();
    }
    if (path === "/api/session/session/prompt") {
      calls.push("prompt");
      response.statusCode = 500;
      response.setHeader("content-type", "application/json");
      return response.end(JSON.stringify({ errors: [{ message: "fake prompt failure" }] }));
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ errors: [{ message: "Not found" }] }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const endpoint: Endpoint = {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
  };
  const client = createOpenCodeConversationClient({ discover: async () => endpoint });
  try {
    await expect(client.send("session", "/tmp/worktree", "prompt-1", "hello")).rejects.toThrow();
    expect(switchedModel).toEqual({ id: "free-default", providerID: "opencode" });
    expect(calls).toEqual(["default", "switch", "prompt"]);
  } finally {
    server.closeAllConnections();
    for (const instance of servers) instance.close();
  }
});

test("refuses to prompt when the worktree has no default model", async () => {
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    if (path === "/api/info") {
      response.setHeader("content-type", "application/json");
      return response.end(
        JSON.stringify({ version: "2.4.1", pid: 1, urls: [], paths: { tmp: "/tmp" } }),
      );
    }
    if (path === "/api/model/default") {
      response.setHeader("content-type", "application/json");
      return response.end(JSON.stringify({ data: null }));
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ errors: [{ message: "Not found" }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const endpoint: Endpoint = {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
  };
  const client = createOpenCodeConversationClient({ discover: async () => endpoint });
  try {
    await expect(client.send("session", "/tmp/worktree", "prompt-1", "hello")).rejects.toThrow(
      "OpenCode has no default chat model configured for this worktree. Choose an available model in Eden or configure a default in OpenCode.",
    );
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
