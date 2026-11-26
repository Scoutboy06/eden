import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { WebSocket } from "ws";

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

test("subscribes to authorized worktree snapshots and pushes persisted visibility updates", async () => {
  const root = await mkdtemp(join(tmpdir(), "eden-conversation-socket-"));
  directories.push(root);
  const worktree = join(root, "checkout");
  await mkdir(worktree);
  const url = await start({
    root,
    worktree,
    client: {} as OpenCodeConversationClient,
    databasePath: join(root, "conversations.sqlite"),
  });
  await expectConversationWebSocketRejected(
    new WebSocket(`${url.replace(/^http/, "ws")}/api/conversations/socket`, {
      origin: "http://evil.example",
    }),
  );
  const first = await connectConversationSocket(url);
  const second = await connectConversationSocket(url);
  const firstInitial = nextSocketMessage(first);
  const secondInitial = nextSocketMessage(second);
  first.send(
    JSON.stringify({
      type: "subscribe",
      project: "project",
      worktree: "checkout",
      branch: "slice",
    }),
  );
  second.send(
    JSON.stringify({
      type: "subscribe",
      project: "project",
      worktree: "checkout",
      branch: "slice",
    }),
  );
  expect((await firstInitial).conversations).toEqual([]);
  expect((await secondInitial).conversations).toEqual([]);

  const firstCreated = nextSocketMessage(first);
  const secondCreated = nextSocketMessage(second);
  const created = await fetch(`${url}/api/conversations`, {
    method: "POST",
    headers: { origin: url, "content-type": "application/json" },
    body: JSON.stringify({ project: "project", worktree: "checkout", branch: "slice" }),
  });
  const { conversation } = (await created.json()) as { conversation: { id: string } };
  expect((await firstCreated).conversations).toHaveLength(1);
  expect((await secondCreated).conversations).toHaveLength(1);

  const firstHidden = nextSocketMessage(first);
  const secondHidden = nextSocketMessage(second);
  await fetch(`${url}/api/conversations/${conversation.id}/close`, {
    method: "POST",
    headers: { origin: url, "content-type": "application/json" },
    body: JSON.stringify({ project: "project", worktree: "checkout", branch: "slice" }),
  });
  const hiddenSnapshot = await firstHidden;
  expect(hiddenSnapshot.conversations).toEqual([]);
  expect(hiddenSnapshot.hiddenConversations).toHaveLength(1);
  expect((await secondHidden).hiddenConversations).toHaveLength(1);

  first.close();
  second.close();
});

test("lists bounded project-scoped conversation summaries without recovering harness sessions", async () => {
  const root = await mkdtemp(join(tmpdir(), "eden-conversation-summaries-"));
  directories.push(root);
  const databasePath = join(root, "conversations.sqlite");
  const worktree = join(root, "checkout");
  await mkdir(worktree);
  let recoveries = 0;
  const client = {
    async reconcileAvailable() {
      recoveries += 1;
      return null;
    },
  } as unknown as OpenCodeConversationClient;
  const url = await start({
    root,
    worktree,
    client,
    databasePath,
  });

  const createdResponse = await fetch(`${url}/api/conversations`, {
    method: "POST",
    headers: { origin: url, "content-type": "application/json" },
    body: JSON.stringify({ project: "project", worktree: "checkout", branch: "slice" }),
  });
  const { conversation } = (await createdResponse.json()) as { conversation: { id: string } };
  const { Database } = await import("bun:sqlite");
  const database = new Database(databasePath);
  database
    .query(
      "UPDATE conversations SET status = 'incomplete', native_session_id = 'native', selected_model_label = 'Fixture model', messages = ? WHERE id = ?",
    )
    .run(
      JSON.stringify([{ role: "user", text: "A bounded conversation title", createdAt: 1 }]),
      conversation.id,
    );
  database.close();

  const response = await fetch(`${url}/api/conversations/summaries?project=project`, {
    headers: { origin: url },
  });
  const result = (await response.json()) as {
    summaries: Array<Record<string, unknown>>;
  };
  expect(response.status).toBe(200);
  expect(result.summaries).toEqual([
    {
      id: conversation.id,
      worktree: "checkout",
      branch: "slice",
      title: "A bounded conversation title",
      status: "incomplete",
      model: "Fixture model",
      updatedAt: expect.any(Number),
    },
  ]);
  expect(result.summaries[0]).not.toHaveProperty("messages");
  expect(recoveries).toBe(0);
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
  let submittedModel: { id: string; providerID: string } | undefined;
  const client: OpenCodeConversationClient = {
    async prepare() {},
    async models(directory) {
      expect(directory).toBe(worktree);
      return [
        {
          key: '["mock","cheap-model"]',
          id: "cheap-model",
          providerID: "mock",
          name: "Cheap model",
        },
      ];
    },
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
    async forms() {
      return [];
    },
    async form() {
      throw new Error("No pending form.");
    },
    async replyForm() {},
    async observe() {},
    async send(id, _directory, promptID, text, onEvent, model) {
      expect(id).toBe(nativeSessionID);
      submittedPromptID = promptID;
      submittedModel = model;
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

  const modelsResponse = await fetch(`${url}/api/conversations/${created.id}/models`, {
    headers: { origin: url },
  });
  expect(modelsResponse.status).toBe(200);
  expect((await modelsResponse.json()).models).toEqual([
    {
      key: '["mock","cheap-model"]',
      id: "cheap-model",
      providerID: "mock",
      name: "Cheap model",
    },
  ]);
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

  const selectedSend = await fetch(`${url}/api/conversations/${created.id}/send`, {
    method: "POST",
    headers: { origin: url, "content-type": "application/json" },
    body: JSON.stringify({ text: "use this model", modelKey: '["mock","cheap-model"]' }),
  });
  expect(selectedSend.status).toBe(200);
  expect(submittedModel).toEqual({ id: "cheap-model", providerID: "mock" });
  expect((await selectedSend.json()).conversation.selectedModelLabel).toBe("Cheap model · mock");
  expect(sends).toBe(3);

  const followupSend = await fetch(`${url}/api/conversations/${created.id}/send`, {
    method: "POST",
    headers: { origin: url, "content-type": "application/json" },
    body: JSON.stringify({ text: "keep using this model" }),
  });
  expect(followupSend.status).toBe(200);
  expect(submittedModel).toEqual({ id: "cheap-model", providerID: "mock" });
  expect(sends).toBe(4);
  const reloaded = await fetch(`${url}/api/conversations/${created.id}`, {
    headers: { origin: url },
  });
  const { conversation: reloadedConversation } = await reloaded.json();
  expect(reloadedConversation.selectedModelKey).toBe('["mock","cheap-model"]');
  expect(reloadedConversation.selectedModelLabel).toBe("Cheap model · mock");

  const defaultSend = await fetch(`${url}/api/conversations/${created.id}/send`, {
    method: "POST",
    headers: { origin: url, "content-type": "application/json" },
    body: JSON.stringify({ text: "use default model", modelKey: null }),
  });
  expect(defaultSend.status).toBe(200);
  expect((await defaultSend.json()).conversation).toMatchObject({
    selectedModelKey: null,
    selectedModelLabel: null,
  });
  expect(submittedModel).toBeUndefined();
  expect(sends).toBe(5);

  const rejectedModel = await fetch(`${url}/api/conversations/${created.id}/send`, {
    method: "POST",
    headers: { origin: url, "content-type": "application/json" },
    body: JSON.stringify({ text: "do not send", modelKey: '["other","model"]' }),
  });
  expect(rejectedModel.status).toBe(400);
  expect(sends).toBe(5);
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
      forms: async () => [],
      form: async () => {
        throw new Error("No pending form.");
      },
      replyForm: async () => {},
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
    forms: async () => [],
    form: async () => {
      throw new Error("No pending form.");
    },
    replyForm: async () => {},
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
    forms: async () => [],
    form: async () => {
      throw new Error("No pending form.");
    },
    replyForm: async () => {},
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
    forms: async () => [],
    form: async () => {
      throw new Error("No pending form.");
    },
    replyForm: async () => {},
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

test("native forms expose supported fields, reject unsupported and stale answers, and forward only validated user input", async () => {
  const root = await mkdtemp(join(tmpdir(), "eden-conversation-"));
  directories.push(root);
  const worktree = join(root, "checkout");
  await mkdir(worktree);
  let finishTurn!: () => void;
  const turn = new Promise<void>((resolve) => {
    finishTurn = resolve;
  });
  let releaseFormReply!: () => void;
  let notifyFormReply!: () => void;
  const formReplyGate = new Promise<void>((resolve) => {
    releaseFormReply = resolve;
  });
  const formReplyStarted = new Promise<void>((resolve) => {
    notifyFormReply = resolve;
  });
  const supported = {
    id: "form-1",
    sessionID: "native-session",
    title: "Deployment details",
    fields: [
      {
        key: "region",
        type: "string",
        title: "Region",
        required: true,
        options: [
          { value: "eu", label: "Europe" },
          { value: "us", label: "United States" },
        ],
      },
      {
        key: "replicas",
        type: "integer",
        title: "Replicas",
        required: true,
        minimum: 1,
        maximum: 5,
      },
      { key: "notify", type: "boolean", title: "Notify team" },
    ],
  } as const;
  const unsupported = {
    id: "form-2",
    sessionID: "native-session",
    title: "External approval",
    fields: [{ key: "approval", type: "external", url: "https://example.com", title: "Approval" }],
  } as const;
  const replies: unknown[] = [];
  let answered = false;
  const client: OpenCodeConversationClient = {
    prepare: async () => {},
    create: async () => "native-session",
    inspect: async () => ({ active: false }),
    reconcile: async () => ({ active: false, reply: null }),
    reconcileAvailable: async () => null,
    interrupt: async () => false,
    permissions: async () => [],
    replyPermission: async () => {},
    forms: async () => (answered ? [] : ([supported, unsupported] as never)),
    form: async (_sessionID, _directory, formID) => {
      const form = formID === "form-1" ? supported : unsupported;
      return {
        ...form,
        state: answered ? { status: "answered", answer: {} } : { status: "pending" },
      } as never;
    },
    replyForm: async (_sessionID, _directory, formID, answer) => {
      replies.push({ formID, answer });
      notifyFormReply();
      await formReplyGate;
      answered = true;
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
    body: JSON.stringify({ text: "deploy" }),
  });
  try {
    await waitFor(async () => {
      const response = await fetch(`${url}/api/conversations/${conversation.id}`);
      const body = (await response.json()) as {
        conversation: { forms?: { id: string; unsupported: string[] }[] };
      };
      return body.conversation.forms?.length === 2;
    });
    const visible = await fetch(`${url}/api/conversations/${conversation.id}`);
    const visibleForms = (await visible.json()).conversation.forms as {
      id: string;
      unsupported: string[];
    }[];
    expect(visibleForms[0]?.unsupported).toEqual([]);
    expect(visibleForms[1]?.unsupported).toContain("Approval: external fields are not supported");

    const unsupportedReply = await fetch(
      `${url}/api/conversations/${conversation.id}/forms/form-2`,
      {
        method: "POST",
        headers: { origin: url, "content-type": "application/json" },
        body: JSON.stringify({ answer: { approval: "yes" } }),
      },
    );
    expect(unsupportedReply.status).toBe(400);

    const invalidReply = await fetch(`${url}/api/conversations/${conversation.id}/forms/form-1`, {
      method: "POST",
      headers: { origin: url, "content-type": "application/json" },
      body: JSON.stringify({ answer: { region: "eu", replicas: 6, notify: false } }),
    });
    expect(invalidReply.status).toBe(400);
    expect(replies).toEqual([]);

    const validReplyPromise = fetch(`${url}/api/conversations/${conversation.id}/forms/form-1`, {
      method: "POST",
      headers: { origin: url, "content-type": "application/json" },
      body: JSON.stringify({ answer: { region: "eu", replicas: 3, notify: false } }),
    });
    await formReplyStarted;
    const duplicateReply = await fetch(`${url}/api/conversations/${conversation.id}/forms/form-1`, {
      method: "POST",
      headers: { origin: url, "content-type": "application/json" },
      body: JSON.stringify({ answer: { region: "us", replicas: 2 } }),
    });
    expect(duplicateReply.status).toBe(409);
    releaseFormReply();
    const validReply = await validReplyPromise;
    expect(validReply.status).toBe(200);
    expect(replies).toEqual([
      { formID: "form-1", answer: { region: "eu", replicas: 3, notify: false } },
    ]);
    const staleReply = await fetch(`${url}/api/conversations/${conversation.id}/forms/form-1`, {
      method: "POST",
      headers: { origin: url, "content-type": "application/json" },
      body: JSON.stringify({ answer: { region: "us", replicas: 2 } }),
    });
    expect(staleReply.status).toBe(409);
    expect(replies).toHaveLength(1);
  } finally {
    releaseFormReply();
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
    forms: async () => [],
    form: async () => {
      throw new Error("No pending form.");
    },
    replyForm: async () => {},
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
  server.on("upgrade", (request, socket, head) => {
    if (!middleware.upgrade(request, socket, head)) socket.destroy();
  });
  server.on("close", () => middleware.close());
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

async function connectConversationSocket(url: string) {
  const socket = new WebSocket(`${url.replace(/^http/, "ws")}/api/conversations/socket`, {
    origin: url,
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return socket;
}

function expectConversationWebSocketRejected(socket: WebSocket) {
  return new Promise<void>((resolve, reject) => {
    socket.once("open", () => {
      socket.close();
      reject(new Error("Cross-origin conversation socket unexpectedly opened."));
    });
    socket.once("error", () => resolve());
  });
}

function nextSocketMessage(socket: WebSocket) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Conversation snapshot timed out.")), 1000);
    socket.once("message", (raw) => {
      clearTimeout(timeout);
      resolve(JSON.parse(raw.toString()) as Record<string, unknown>);
    });
  });
}

async function waitFor(check: () => Promise<boolean>) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await check()) return;
    await Bun.sleep(20);
  }
  throw new Error("Condition did not become true.");
}
