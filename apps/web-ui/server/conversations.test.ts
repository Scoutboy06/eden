import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";

import type { OpenCodeConversationClient } from "../../../src/external/opencode/client";
import { createConversationMiddleware } from "./conversations";

const directories: string[] = [];
const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) server.close();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test("creates a local conversation without a provider session and reuses its native ID on send", async () => {
  const root = await mkdtemp(join(tmpdir(), "eden-conversation-"));
  directories.push(root);
  const worktree = join(root, "checkout");
  await mkdir(worktree);
  let nativeSessionID = "";
  let creates = 0;
  let sends = 0;
  let submittedPromptID = "";
  const client: OpenCodeConversationClient = {
    async prepare() {},
    async create() {
      creates += 1;
      return (nativeSessionID = "native-session");
    },
    async inspect(id) {
      expect(id).toBe(nativeSessionID);
      return { active: false };
    },
    async reconcile() {
      return { active: false, reply: null };
    },
    async reconcileAvailable() {
      return null;
    },
    async interrupt() {
      return false;
    },
    async permissions() {
      return [];
    },
    async replyPermission() {},
    async observe() {},
    async send(id, _directory, promptID, text, onEvent) {
      expect(id).toBe(nativeSessionID);
      submittedPromptID = promptID;
      sends += 1;
      const reply = `Reply to ${text}`;
      onEvent?.({ type: "attempting" });
      onEvent?.({ type: "settled", reply });
      return { reply };
    },
  };
  const url = await start({
    root,
    worktree,
    client,
    databasePath: join(root, "conversations.sqlite"),
  });

  const createdResponse = await fetch(`${url}/api/conversations`, {
    method: "POST",
    headers: { origin: url, "content-type": "application/json" },
    body: JSON.stringify({ project: "project", worktree: "checkout", branch: "slice" }),
  });
  const { conversation: created } = (await createdResponse.json()) as {
    conversation: { id: string; status: string };
  };
  expect(createdResponse.status).toBe(201);
  expect(created.status).toBe("ready");
  expect(creates).toBe(0);

  const sentResponse = await fetch(`${url}/api/conversations/${created.id}/send`, {
    method: "POST",
    headers: { origin: url, "content-type": "application/json" },
    body: JSON.stringify({ text: "hello" }),
  });
  const { conversation: sent } = (await sentResponse.json()) as {
    conversation: {
      messages: { role: string; text: string }[];
      nativeSessionID?: string;
      directory?: string;
    };
  };
  expect(sentResponse.status).toBe(200);
  expect(sent.nativeSessionID).toBeUndefined();
  expect(sent.directory).toBeUndefined();
  expect(sent.messages.map(({ role, text }) => [role, text])).toEqual([
    ["user", "hello"],
    ["assistant", "Reply to hello"],
  ]);
  expect(creates).toBe(1);
  expect(sends).toBe(1);
  expect(submittedPromptID).toMatch(/^msg_[0-9a-f]{32}$/);

  const secondSend = await fetch(`${url}/api/conversations/${created.id}/send`, {
    method: "POST",
    headers: { origin: url, "content-type": "application/json" },
    body: JSON.stringify({ text: "again" }),
  });
  expect(secondSend.status).toBe(200);
  expect(creates).toBe(1);
  expect(sends).toBe(2);
});

test("rejects cross-origin requests before touching conversation storage", async () => {
  const root = await mkdtemp(join(tmpdir(), "eden-conversation-"));
  directories.push(root);
  const worktree = join(root, "checkout");
  await mkdir(worktree);
  const url = await start({
    root,
    worktree,
    client: {
      prepare: async () => {},
      create: async () => "session",
      inspect: async () => ({ active: false }),
      reconcile: async () => ({ active: false, reply: null }),
      reconcileAvailable: async () => null,
      interrupt: async () => false,
      permissions: async () => [],
      replyPermission: async () => {},
      observe: async () => {},
      send: async () => ({ reply: "reply" }),
    },
    databasePath: join(root, "conversations.sqlite"),
  });
  const response = await fetch(`${url}/api/conversations`, {
    headers: { origin: "http://evil.example" },
  });
  expect(response.status).toBe(403);
});

test("rejects a second prompt while the first turn is active", async () => {
  const root = await mkdtemp(join(tmpdir(), "eden-conversation-"));
  directories.push(root);
  const worktree = join(root, "checkout");
  await mkdir(worktree);
  let release!: () => void;
  let finishActiveTurn!: () => void;
  let sends = 0;
  const turn = new Promise<void>((resolve) => {
    release = resolve;
  });
  const client: OpenCodeConversationClient = {
    prepare: async () => {},
    create: async () => "session",
    inspect: async () => ({ active: false }),
    reconcile: async () => ({ active: false, reply: null }),
    reconcileAvailable: async () => null,
    interrupt: async () => {
      finishActiveTurn();
      return true;
    },
    permissions: async () => [],
    replyPermission: async () => {},
    observe: async () => {},
    send: async (_id, _directory, _promptID, _text, onEvent) => {
      sends += 1;
      onEvent?.({ type: "attempting" });
      onEvent?.({ type: "accepted", userMessageID: "user-id" });
      if (sends === 1) {
        finishActiveTurn = () => {
          onEvent?.({ type: "settled", reply: "partial reply" });
          release();
        };
        await turn;
        return { reply: "partial reply" };
      }
      onEvent?.({ type: "settled", reply: "continued reply" });
      return { reply: "continued reply" };
    },
  };
  const url = await start({
    root,
    worktree,
    client,
    databasePath: join(root, "conversations.sqlite"),
  });
  const created = await fetch(`${url}/api/conversations`, {
    method: "POST",
    headers: { origin: url, "content-type": "application/json" },
    body: JSON.stringify({ project: "project", worktree: "checkout", branch: "slice" }),
  });
  const { conversation } = (await created.json()) as { conversation: { id: string } };
  const first = fetch(`${url}/api/conversations/${conversation.id}/send`, {
    method: "POST",
    headers: { origin: url, "content-type": "application/json" },
    body: JSON.stringify({ text: "first" }),
  });
  await waitFor(async () => {
    const result = await fetch(`${url}/api/conversations/${conversation.id}`);
    const body = (await result.json()) as { conversation: { status: string } };
    return body.conversation.status === "active";
  });
  const second = await fetch(`${url}/api/conversations/${conversation.id}/send`, {
    method: "POST",
    headers: { origin: url, "content-type": "application/json" },
    body: JSON.stringify({ text: "second" }),
  });
  expect(second.status).toBe(409);
  const stopped = await fetch(`${url}/api/conversations/${conversation.id}/stop`, {
    method: "POST",
    headers: { origin: url },
  });
  expect(stopped.status).toBe(202);
  expect((await first).status).toBe(200);
  const stoppedConversation = await fetch(`${url}/api/conversations/${conversation.id}`);
  const stoppedBody = (await stoppedConversation.json()) as {
    conversation: { status: string; messages: { role: string; text: string }[] };
  };
  expect(stoppedBody.conversation.status).toBe("ready");
  expect(stoppedBody.conversation.messages.at(-1)?.text).toBe("partial reply");
  const followUp = await fetch(`${url}/api/conversations/${conversation.id}/send`, {
    method: "POST",
    headers: { origin: url, "content-type": "application/json" },
    body: JSON.stringify({ text: "continue" }),
  });
  expect(followUp.status).toBe(200);
  expect(sends).toBe(2);
});

test("two browser clients read one durable live transcript without waking the provider", async () => {
  const root = await mkdtemp(join(tmpdir(), "eden-conversation-"));
  directories.push(root);
  const worktree = join(root, "checkout");
  await mkdir(worktree);
  let release!: () => void;
  let wakes = 0;
  let emitAfterClose: (() => void) | undefined;
  const turn = new Promise<void>((resolve) => {
    release = resolve;
  });
  const client: OpenCodeConversationClient = {
    prepare: async () => {
      wakes += 1;
    },
    create: async () => "native-session",
    inspect: async () => ({ active: false }),
    reconcile: async () => ({ active: false, reply: null }),
    reconcileAvailable: async () => null,
    interrupt: async () => false,
    permissions: async () => [],
    replyPermission: async () => {},
    observe: async () => {},
    send: async (_id, _directory, _promptID, _text, onEvent) => {
      onEvent?.({ type: "attempting" });
      onEvent?.({ type: "accepted", userMessageID: "native-user" });
      onEvent?.({ type: "text", assistantMessageID: "assistant", delta: "partial " });
      emitAfterClose = () =>
        onEvent?.({ type: "text", assistantMessageID: "assistant", delta: "" });
      await turn;
      onEvent?.({ type: "settled", reply: "partial reply" });
      return { reply: "partial reply" };
    },
  };
  const url = await start({
    root,
    worktree,
    client,
    databasePath: join(root, "conversations.sqlite"),
  });
  const created = await fetch(`${url}/api/conversations`, {
    method: "POST",
    headers: { origin: url, "content-type": "application/json" },
    body: JSON.stringify({ project: "project", worktree: "checkout", branch: "slice" }),
  });
  const { conversation } = (await created.json()) as { conversation: { id: string } };
  const firstBrowserSend = fetch(`${url}/api/conversations/${conversation.id}/send`, {
    method: "POST",
    headers: { origin: url, "content-type": "application/json" },
    body: JSON.stringify({ text: "hello" }),
  });
  try {
    await waitFor(async () => {
      const list = await fetch(
        `${url}/api/conversations?project=project&worktree=checkout&branch=slice`,
      );
      const body = (await list.json()) as {
        conversations: { messages: { text: string }[] }[];
      };
      return body.conversations[0]?.messages[1]?.text === "partial ";
    });
    const secondBrowser = await fetch(`${url}/api/conversations/${conversation.id}`, {
      headers: { origin: url },
    });
    const body = (await secondBrowser.json()) as {
      conversation: { messages: { text: string }[] };
    };
    expect(secondBrowser.status).toBe(200);
    expect(body.conversation.messages[1]?.text).toBe("partial ");
    expect(wakes).toBe(1);

    const close = await fetch(`${url}/api/conversations/${conversation.id}/close`, {
      method: "POST",
      headers: { origin: url, "content-type": "application/json" },
      body: JSON.stringify({ project: "project", worktree: "checkout", branch: "slice" }),
    });
    expect(close.status).toBe(200);
    expect((await close.json()).conversation.hidden).toBe(true);
    emitAfterClose?.();
    const hiddenList = (await (
      await fetch(`${url}/api/conversations?project=project&worktree=checkout&branch=slice`)
    ).json()) as { conversations: unknown[]; hiddenConversations: { id: string }[] };
    expect(hiddenList.conversations).toHaveLength(0);
    expect(hiddenList.hiddenConversations.map(({ id }) => id)).toEqual([conversation.id]);

    const wrongScope = await fetch(`${url}/api/conversations/${conversation.id}/reopen`, {
      method: "POST",
      headers: { origin: url, "content-type": "application/json" },
      body: JSON.stringify({ project: "project", worktree: "other", branch: "slice" }),
    });
    expect(wrongScope.status).toBe(404);

    const reopen = await fetch(`${url}/api/conversations/${conversation.id}/reopen`, {
      method: "POST",
      headers: { origin: url, "content-type": "application/json" },
      body: JSON.stringify({ project: "project", worktree: "checkout", branch: "slice" }),
    });
    expect(reopen.status).toBe(200);
    expect((await reopen.json()).conversation.hidden).toBe(false);
    expect(wakes).toBe(1);
    const restored = await fetch(`${url}/api/conversations/${conversation.id}`);
    const restoredBody = (await restored.json()) as {
      conversation: { status: string; messages: { text: string }[] };
    };
    expect(restoredBody.conversation.status).toBe("active");
    expect(restoredBody.conversation.messages[1]?.text).toBe("partial ");
  } finally {
    release();
  }
  expect((await firstBrowserSend).status).toBe(200);
});

test("pending native approvals are visible to every browser and only the first exact choice is forwarded", async () => {
  const root = await mkdtemp(join(tmpdir(), "eden-conversation-"));
  directories.push(root);
  const worktree = join(root, "checkout");
  await mkdir(worktree);
  let finishTurn!: () => void;
  let acceptReply!: () => void;
  let notifyReply!: () => void;
  const turn = new Promise<void>((resolve) => {
    finishTurn = resolve;
  });
  const replyGate = new Promise<void>((resolve) => {
    acceptReply = resolve;
  });
  const replyStarted = new Promise<void>((resolve) => {
    notifyReply = resolve;
  });
  const pending = [{ id: "permission-1", action: "read", resources: ["src/index.ts"] }];
  const decisions: string[] = [];
  const client: OpenCodeConversationClient = {
    prepare: async () => {},
    create: async () => "native-session",
    inspect: async () => ({ active: false }),
    reconcile: async () => ({ active: false, reply: null }),
    reconcileAvailable: async () => null,
    interrupt: async () => false,
    permissions: async () => pending,
    replyPermission: async (_sessionID, _directory, requestID, decision) => {
      expect(requestID).toBe("permission-1");
      notifyReply();
      await replyGate;
      decisions.push(decision);
      pending.splice(0);
    },
    observe: async () => {},
    send: async (_id, _directory, _promptID, _text, onEvent) => {
      onEvent?.({ type: "attempting" });
      onEvent?.({ type: "accepted", userMessageID: "native-user" });
      onEvent?.({ type: "blocked" });
      await turn;
      onEvent?.({ type: "settled", reply: "done" });
      return { reply: "done" };
    },
  };
  const url = await start({
    root,
    worktree,
    client,
    databasePath: join(root, "conversations.sqlite"),
  });
  const created = await fetch(`${url}/api/conversations`, {
    method: "POST",
    headers: { origin: url, "content-type": "application/json" },
    body: JSON.stringify({ project: "project", worktree: "checkout", branch: "slice" }),
  });
  const { conversation } = (await created.json()) as { conversation: { id: string } };
  const activeTurn = fetch(`${url}/api/conversations/${conversation.id}/send`, {
    method: "POST",
    headers: { origin: url, "content-type": "application/json" },
    body: JSON.stringify({ text: "hello" }),
  });
  try {
    await waitFor(async () => {
      const response = await fetch(
        `${url}/api/conversations?project=project&worktree=checkout&branch=slice`,
      );
      const body = (await response.json()) as {
        conversations: { approvals?: typeof pending }[];
      };
      return body.conversations[0]?.approvals?.length === 1;
    });
    const secondBrowser = await fetch(`${url}/api/conversations/${conversation.id}`);
    expect(
      ((await secondBrowser.json()) as { conversation: { approvals: typeof pending } }).conversation
        .approvals,
    ).toEqual(pending);

    const firstReply = fetch(
      `${url}/api/conversations/${conversation.id}/permissions/permission-1`,
      {
        method: "POST",
        headers: { origin: url, "content-type": "application/json" },
        body: JSON.stringify({ decision: "once" }),
      },
    );
    await replyStarted;
    const staleReply = await fetch(
      `${url}/api/conversations/${conversation.id}/permissions/permission-1`,
      {
        method: "POST",
        headers: { origin: url, "content-type": "application/json" },
        body: JSON.stringify({ decision: "reject" }),
      },
    );
    expect(staleReply.status).toBe(409);
    acceptReply();
    expect((await firstReply).status).toBe(200);
    expect(decisions).toEqual(["once"]);

    const converged = await fetch(`${url}/api/conversations/${conversation.id}`);
    expect(
      ((await converged.json()) as { conversation: { approvals: typeof pending } }).conversation
        .approvals,
    ).toEqual([]);
  } finally {
    finishTurn();
  }
  expect((await activeTurn).status).toBe(200);
});

test("a definitive provider preflight failure removes the unsent draft from the transcript", async () => {
  const root = await mkdtemp(join(tmpdir(), "eden-conversation-"));
  directories.push(root);
  const worktree = join(root, "checkout");
  await mkdir(worktree);
  let sends = 0;
  const client: OpenCodeConversationClient = {
    prepare: async () => {
      throw new Error("private endpoint/path detail");
    },
    create: async () => "native-session",
    inspect: async () => ({ active: false }),
    reconcile: async () => ({ active: false, reply: null }),
    reconcileAvailable: async () => null,
    interrupt: async () => false,
    permissions: async () => [],
    replyPermission: async () => {},
    observe: async () => {},
    send: async () => {
      sends += 1;
      return { reply: "unexpected" };
    },
  };
  const url = await start({
    root,
    worktree,
    client,
    databasePath: join(root, "conversations.sqlite"),
  });
  const created = await fetch(`${url}/api/conversations`, {
    method: "POST",
    headers: { origin: url, "content-type": "application/json" },
    body: JSON.stringify({ project: "project", worktree: "checkout", branch: "slice" }),
  });
  const { conversation } = (await created.json()) as { conversation: { id: string } };
  const response = await fetch(`${url}/api/conversations/${conversation.id}/send`, {
    method: "POST",
    headers: { origin: url, "content-type": "application/json" },
    body: JSON.stringify({ text: "unsent" }),
  });
  const body = (await response.json()) as {
    error: string;
    conversation: { status: string; messages: unknown[] };
  };
  expect(response.status).toBe(503);
  expect(body.error).not.toContain("private endpoint");
  expect(body.conversation.status).toBe("ready");
  expect(body.conversation.messages).toEqual([]);
  expect(sends).toBe(0);
});

async function start({
  root,
  worktree,
  client,
  databasePath,
}: {
  root: string;
  worktree: string;
  client: OpenCodeConversationClient;
  databasePath: string;
}) {
  const middleware = createConversationMiddleware({
    readProjects: async () => ({ project: { name: "Project", path: root } }),
    worktrees: async () => [{ path: worktree, branch: "slice" }],
    client,
    databasePath,
  });
  const server = createServer(
    (request, response) =>
      void middleware(request, response, () => {
        response.statusCode = 404;
        response.end();
      }),
  );
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

async function waitFor(check: () => Promise<boolean>) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await check()) return;
    await Bun.sleep(20);
  }
  throw new Error("Condition did not become true.");
}
