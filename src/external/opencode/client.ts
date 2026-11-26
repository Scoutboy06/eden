import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { OpenCode, type FormDetail, type FormInfo } from "@opencode/client";
import { Service, type Endpoint } from "@opencode/client/service";

const compatibleVersion = (version: string) => version.startsWith("2.4.");
const settleEvents = [
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
] as const;

export type PromptEvent =
  | { type: "attempting" }
  | { type: "accepted"; userMessageID: string }
  | { type: "text"; assistantMessageID: string; delta: string }
  | {
      type: "tool";
      assistantMessageID: string;
      id: string;
      name: string;
      status: "running" | "completed" | "failed";
    }
  | { type: "blocked" }
  | { type: "settled"; reply: string };

export type ObservationEvent =
  | { type: "text"; assistantMessageID: string; delta: string }
  | {
      type: "tool";
      assistantMessageID: string;
      id: string;
      name: string;
      status: "running" | "completed" | "failed";
    }
  | { type: "blocked" }
  | { type: "settled"; reply: string };

export type OpenCodeModelChoice = {
  key: string;
  id: string;
  providerID: string;
  name: string;
  group?: { key: string; label: string };
};

let waking: Promise<Endpoint> | undefined;

export type OpenCodeConversationClient = {
  prepare(directory: string): Promise<void>;
  models?(directory: string): Promise<OpenCodeModelChoice[]>;
  create(directory: string): Promise<string>;
  inspect(sessionID: string, directory: string): Promise<{ active: boolean }>;
  reconcile(
    sessionID: string,
    directory: string,
    promptID: string,
  ): Promise<{ active: boolean; reply: string | null }>;
  reconcileAvailable(
    sessionID: string,
    directory: string,
    promptID: string,
  ): Promise<{ active: boolean; reply: string | null } | null>;
  interrupt(sessionID: string, directory: string): Promise<boolean>;
  permissions(
    sessionID: string,
    directory: string,
  ): Promise<Array<{ id: string; action: string; resources: string[]; message?: string }>>;
  replyPermission(
    sessionID: string,
    directory: string,
    requestID: string,
    decision: "once" | "always" | "reject",
  ): Promise<void>;
  forms(sessionID: string, directory: string): Promise<FormInfo[]>;
  form(sessionID: string, directory: string, formID: string): Promise<FormDetail>;
  replyForm(
    sessionID: string,
    directory: string,
    formID: string,
    answer: Record<string, string | number | boolean>,
  ): Promise<void>;
  observe(
    sessionID: string,
    directory: string,
    promptID: string,
    onEvent: (event: ObservationEvent) => void,
  ): Promise<void>;
  send(
    sessionID: string,
    directory: string,
    promptID: string,
    text: string,
    observe?: (event: PromptEvent) => void,
    model?: Pick<OpenCodeModelChoice, "id" | "providerID">,
  ): Promise<{ reply: string }>;
};

export type OpenCodeClientOptions = {
  discover?: () => Promise<Endpoint | undefined>;
  wake?: () => Promise<Endpoint>;
};

export function createOpenCodeConversationClient(
  options: OpenCodeClientOptions = {},
): OpenCodeConversationClient {
  const discover = options.discover ?? (() => Service.discover());

  return {
    async prepare(directory) {
      await createClient(directory, discover, options);
    },
    async models(directory) {
      const client = await createClient(directory, discover, options);
      const [{ data }, { data: providers }] = await Promise.all([
        client.model.list({ location: { directory }, types: ["chat"] }),
        client.provider.list({ location: { directory } }),
      ]);
      const providerNames = new Map(providers.map(({ id, name }) => [id, name]));
      return data
        .filter((model) => model.enabled)
        .map(({ id, providerID, name }) => ({
          key: JSON.stringify([providerID, id]),
          id,
          providerID,
          name,
          group: { key: providerID, label: providerNames.get(providerID) ?? providerID },
        }));
    },
    async create(directory) {
      const client = await createClient(directory, discover, options);
      const session = await client.session.create({ location: { directory } });
      return session.id;
    },
    async inspect(sessionID, directory) {
      const client = await createClient(directory, discover, options);
      await client.session.get({ sessionID });
      return { active: Object.hasOwn(await client.session.active(), sessionID) };
    },
    async reconcile(sessionID, directory, promptID) {
      const client = await createClient(directory, discover, options);
      return reconcile(client, sessionID, promptID);
    },
    async reconcileAvailable(sessionID, directory, promptID) {
      const endpoint = await discover();
      if (!endpoint) return null;
      const client = await makeClient(endpoint, directory);
      return reconcile(client, sessionID, promptID);
    },
    async interrupt(sessionID, directory) {
      const endpoint = await discover();
      if (!endpoint) throw new Error("OpenCode is not currently reachable.");
      const client = await makeClient(endpoint, directory);
      const result = await client.session.interrupt({ sessionID });
      return result.interrupted;
    },
    async permissions(sessionID, directory) {
      const endpoint = await discover();
      if (!endpoint) throw new Error("OpenCode is not currently reachable.");
      const client = await makeClient(endpoint, directory);
      return client.permission.list({ sessionID });
    },
    async replyPermission(sessionID, directory, requestID, decision) {
      const endpoint = await discover();
      if (!endpoint) throw new Error("OpenCode is not currently reachable.");
      const client = await makeClient(endpoint, directory);
      await client.permission.reply({ sessionID, requestID, decision });
    },
    async forms(sessionID, directory) {
      const endpoint = await discover();
      if (!endpoint) throw new Error("OpenCode is not currently reachable.");
      const client = await makeClient(endpoint, directory);
      return client.session.form.list({ sessionID });
    },
    async form(sessionID, directory, formID) {
      const endpoint = await discover();
      if (!endpoint) throw new Error("OpenCode is not currently reachable.");
      const client = await makeClient(endpoint, directory);
      const form = await client.session.form.get({ sessionID, formID });
      return form;
    },
    async replyForm(sessionID, directory, formID, answer) {
      const endpoint = await discover();
      if (!endpoint) throw new Error("OpenCode is not currently reachable.");
      const client = await makeClient(endpoint, directory);
      await client.session.form.reply({ sessionID, formID, answer });
    },
    async observe(sessionID, directory, promptID, onEvent) {
      const endpoint = await discover();
      if (!endpoint) throw new Error("OpenCode is not currently reachable.");
      const controller = new AbortController();
      const client = await makeClient(endpoint, directory);
      const iterator = subscribe(client, controller.signal)[Symbol.asyncIterator]();
      const assistantIDs = new Set<string>();
      try {
        const first = await iterator.next();
        if (first.done || first.value.type !== "server.connected")
          throw new Error("OpenCode event stream did not connect.");
        const state = await reconcile(client, sessionID, promptID);
        if (!state.active) {
          for (const tool of toolCallsAfterPrompt(await listMessages(client, sessionID), promptID))
            onEvent({ type: "tool", assistantMessageID: tool.assistantMessageID, ...tool.call });
          if (state.reply === null)
            throw new Error("The OpenCode prompt has no authoritative reply.");
          onEvent({ type: "settled", reply: state.reply });
          return;
        }
        const messages = await listMessages(client, sessionID);
        for (const tool of toolCallsAfterPrompt(messages, promptID)) {
          assistantIDs.add(tool.assistantMessageID);
          onEvent({ type: "tool", assistantMessageID: tool.assistantMessageID, ...tool.call });
        }

        for await (const event of { [Symbol.asyncIterator]: () => iterator }) {
          if (
            await processObservationEvent(client, event, sessionID, promptID, onEvent, assistantIDs)
          )
            return;
        }
        throw new Error("OpenCode event stream ended before the turn settled.");
      } finally {
        controller.abort();
      }
    },
    async send(sessionID, directory, promptID, text, observe, model) {
      const endpoint = await discoverOrWake(discover, options);
      const client = await makeClient(endpoint, directory);
      const effectiveModel =
        model ?? (await client.model.default({ location: { directory } })).data;
      if (!effectiveModel)
        throw new Error(
          "OpenCode has no default chat model configured for this worktree. Choose an available model in Eden or configure a default in OpenCode.",
        );
      const controller = new AbortController();
      const iterator = subscribe(client, controller.signal)[Symbol.asyncIterator]();

      let acceptedUserID: string | undefined;
      let acceptedAt: number | undefined;
      const queued: Event[] = [];
      const pendingText = new Map<string, string>();
      const pendingTools = new Map<string, ToolCall[]>();
      const assistantIDs = new Set<string>();
      let resolveTurn!: (reply: string) => void;
      let rejectTurn!: (error: Error) => void;
      const completed = new Promise<string>((resolve, reject) => {
        resolveTurn = resolve;
        rejectTurn = reject;
      });
      void completed.catch(() => {});
      async function processEvent(event: Event) {
        await processPromptEvent(event, {
          client,
          sessionID,
          acceptedUserID: acceptedUserID!,
          acceptedAt,
          pendingText,
          pendingTools,
          assistantIDs,
          observe,
          rejectTurn,
          resolveTurn,
        });
      }

      try {
        const first = await iterator.next();
        if (first.done || first.value.type !== "server.connected")
          throw new Error("OpenCode event stream did not connect.");
        const monitor = (async () => {
          for await (const event of { [Symbol.asyncIterator]: () => iterator }) {
            if (!acceptedUserID) {
              queued.push(event);
              continue;
            }
            await processEvent(event);
          }
          throw new Error("OpenCode event stream ended before the turn settled.");
        })();
        void monitor.catch((error) => {
          rejectTurn(asError(error));
        });
        observe?.({ type: "attempting" });
        await client.session.switchModel({
          sessionID,
          model: { id: effectiveModel.id, providerID: effectiveModel.providerID },
        });
        const accepted = await client.session.prompt({ sessionID, id: promptID, text });
        acceptedUserID = accepted.id;
        acceptedAt = accepted.time.created;
        observe?.({ type: "accepted", userMessageID: accepted.id });
        for (const event of queued.splice(0)) await processEvent(event);
        const reply = await completed;
        return { reply };
      } catch (error) {
        throw asError(error);
      } finally {
        controller.abort();
      }
    },
  };
}

type Event = Awaited<
  ReturnType<ReturnType<typeof OpenCode.make>["event"]["subscribe"]> extends AsyncIterable<infer T>
    ? T
    : never
>;

type ToolCall = { id: string; name: string; status: "running" | "completed" | "failed" };

type PromptEventState = {
  client: ReturnType<typeof OpenCode.make>;
  sessionID: string;
  acceptedUserID: string;
  acceptedAt: number | undefined;
  pendingText: Map<string, string>;
  pendingTools: Map<string, ToolCall[]>;
  assistantIDs: Set<string>;
  observe: ((event: PromptEvent) => void) | undefined;
  rejectTurn: (error: Error) => void;
  resolveTurn: (reply: string) => void;
};

async function processObservationEvent(
  client: ReturnType<typeof OpenCode.make>,
  event: Event,
  sessionID: string,
  promptID: string,
  onEvent: (event: ObservationEvent) => void,
  assistantIDs: Set<string>,
) {
  if (!belongsToSession(event, sessionID)) return false;

  switch (event.type) {
    case "session.text.started": {
      const messages = await listMessages(client, sessionID);
      if (assistantFollowsPrompt(messages, promptID, event.data.assistantMessageID))
        assistantIDs.add(event.data.assistantMessageID);
      return false;
    }
    case "session.text.delta":
      if (assistantIDs.has(event.data.assistantMessageID))
        onEvent({
          type: "text",
          assistantMessageID: event.data.assistantMessageID,
          delta: event.data.delta,
        });
      return false;
    case "session.tool.input.started":
    case "session.tool.called":
    case "session.tool.success":
    case "session.tool.failed": {
      const tool = toolEvent(event);
      if (tool && assistantIDs.has(tool.assistantMessageID))
        onEvent({ type: "tool", assistantMessageID: tool.assistantMessageID, ...tool.call });
      return false;
    }
    case "permission.asked":
    case "form.created":
      onEvent({ type: "blocked" });
      return false;
    case "session.execution.succeeded":
    case "session.execution.failed":
    case "session.execution.interrupted": {
      const messages = await listMessages(client, sessionID);
      for (const tool of toolCallsAfterPrompt(messages, promptID))
        onEvent({ type: "tool", assistantMessageID: tool.assistantMessageID, ...tool.call });
      const result = await reconcile(client, sessionID, promptID);
      if (result.active) return false;
      if (result.reply === null)
        throw new Error("OpenCode settled without an authoritative reply for this prompt.");
      onEvent({ type: "settled", reply: result.reply });
      return true;
    }
    default:
      return false;
  }
}

async function processPromptEvent(event: Event, state: PromptEventState) {
  if (
    event.type === "server.connected" ||
    !belongsToSession(event, state.sessionID) ||
    (state.acceptedAt !== undefined && event.created < state.acceptedAt)
  )
    return;

  switch (event.type) {
    case "session.text.started":
      await handlePromptTextStarted(event, state);
      return;
    case "session.text.delta":
      handlePromptTextDelta(event, state);
      return;
    case "session.tool.input.started":
    case "session.tool.called":
    case "session.tool.success":
    case "session.tool.failed":
      handlePromptToolEvent(event, state);
      return;
    case "permission.asked":
    case "form.created":
      state.observe?.({ type: "blocked" });
      return;
    case "session.execution.succeeded":
    case "session.execution.failed":
    case "session.execution.interrupted":
      await settlePrompt(state);
  }
}

async function handlePromptTextStarted(
  event: Extract<Event, { type: "session.text.started" }>,
  state: PromptEventState,
) {
  const messages = await listMessages(state.client, state.sessionID);
  if (!assistantFollowsPrompt(messages, state.acceptedUserID, event.data.assistantMessageID))
    return;
  state.assistantIDs.add(event.data.assistantMessageID);
  const buffered = state.pendingText.get(event.data.assistantMessageID);
  if (buffered) {
    state.observe?.({
      type: "text",
      assistantMessageID: event.data.assistantMessageID,
      delta: buffered,
    });
    state.pendingText.delete(event.data.assistantMessageID);
  }
  for (const tool of state.pendingTools.get(event.data.assistantMessageID) ?? [])
    state.observe?.({
      type: "tool",
      assistantMessageID: event.data.assistantMessageID,
      ...tool,
    });
  state.pendingTools.delete(event.data.assistantMessageID);
}

function handlePromptTextDelta(
  event: Extract<Event, { type: "session.text.delta" }>,
  state: PromptEventState,
) {
  if (state.assistantIDs.has(event.data.assistantMessageID)) {
    state.observe?.({
      type: "text",
      assistantMessageID: event.data.assistantMessageID,
      delta: event.data.delta,
    });
    return;
  }
  state.pendingText.set(
    event.data.assistantMessageID,
    (state.pendingText.get(event.data.assistantMessageID) ?? "") + event.data.delta,
  );
}

function handlePromptToolEvent(
  event: Extract<
    Event,
    {
      type:
        | "session.tool.input.started"
        | "session.tool.called"
        | "session.tool.success"
        | "session.tool.failed";
    }
  >,
  state: PromptEventState,
) {
  const tool = toolEvent(event);
  if (!tool) return;
  if (state.assistantIDs.has(tool.assistantMessageID)) {
    state.observe?.({ type: "tool", assistantMessageID: tool.assistantMessageID, ...tool.call });
    return;
  }
  const calls = state.pendingTools.get(tool.assistantMessageID) ?? [];
  calls.push(tool.call);
  state.pendingTools.set(tool.assistantMessageID, calls);
}

async function settlePrompt(state: PromptEventState) {
  const messages = await listMessages(state.client, state.sessionID);
  for (const tool of toolCallsAfterPrompt(messages, state.acceptedUserID))
    state.observe?.({ type: "tool", assistantMessageID: tool.assistantMessageID, ...tool.call });
  const reply = replyAfterPrompt(messages, state.acceptedUserID);
  if (reply === null) {
    state.rejectTurn(new Error("OpenCode settled without an assistant reply for this prompt."));
    return;
  }
  state.observe?.({ type: "settled", reply });
  state.resolveTurn(reply);
}

async function discoverOrWake(
  discover: () => Promise<Endpoint | undefined>,
  options: OpenCodeClientOptions,
) {
  const endpoint = await discover();
  if (endpoint) return endpoint;
  if (options.wake) return options.wake();

  const registration = join(
    process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"),
    "opencode",
    "service.json",
  );
  try {
    await access(registration);
    throw new Error("An OpenCode service is registered but unavailable; Eden will not replace it.");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }

  if (!waking) {
    waking = (async () => {
      const executable = Bun.which("opencode");
      if (!executable) throw new Error("OpenCode is not installed on the Eden server PATH.");
      const child = spawn(executable, ["serve", "--service"], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();
      for (let attempt = 0; attempt < 100; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        const started = await discover();
        if (started) return started;
      }
      throw new Error("OpenCode did not become available.");
    })();
  }
  try {
    return await waking;
  } finally {
    waking = undefined;
  }
}

async function createClient(
  directory: string,
  discover: () => Promise<Endpoint | undefined>,
  options: OpenCodeClientOptions,
) {
  const endpoint = await discoverOrWake(discover, options);
  return makeClient(endpoint, directory);
}

async function makeClient(endpoint: Endpoint, directory: string) {
  const client = OpenCode.make({
    baseUrl: endpoint.url,
    headers: { ...Service.headers(endpoint), "x-opencode-directory": directory },
  });
  const info = await client.server.info();
  if (!compatibleVersion(info.version))
    throw new Error(`OpenCode ${info.version} is not compatible with Eden’s conversation client.`);
  return client;
}

function subscribe(client: ReturnType<typeof OpenCode.make>, signal: AbortSignal) {
  const options = {
    types: [
      "session.text.started",
      "session.text.delta",
      "session.tool.input.started",
      "session.tool.called",
      "session.tool.success",
      "session.tool.failed",
      "permission.asked",
      "form.created",
      ...settleEvents,
    ],
    signal: AbortSignal.any([signal, AbortSignal.timeout(5 * 60_000)]),
  } as Parameters<typeof client.event.subscribe>[0] & { signal: AbortSignal };
  return client.event.subscribe(options);
}

async function reconcile(
  client: ReturnType<typeof OpenCode.make>,
  sessionID: string,
  promptID: string,
) {
  const [messages, active] = await Promise.all([
    listMessages(client, sessionID),
    client.session.active(),
  ]);
  return {
    active: Object.hasOwn(active, sessionID),
    reply: replyAfterPrompt(messages, promptID),
  };
}

async function listMessages(client: ReturnType<typeof OpenCode.make>, sessionID: string) {
  const messages: Awaited<ReturnType<typeof client.message.list>>["data"] = [];
  let cursor: string | undefined;
  do {
    const page = await client.message.list({
      sessionID,
      limit: 100,
      ...(cursor ? { cursor } : { order: "asc" }),
    });
    messages.push(...page.data);
    cursor = page.cursor.next ?? undefined;
  } while (cursor);
  return messages;
}

function assistantFollowsPrompt(
  messages: Awaited<ReturnType<ReturnType<typeof OpenCode.make>["message"]["list"]>>["data"],
  promptID: string,
  assistantID: string,
) {
  const promptIndex = messages.findIndex(
    (message) => message.type === "user" && message.id === promptID,
  );
  if (promptIndex < 0) return false;
  const nextUserIndex = messages.findIndex(
    (message, index) => index > promptIndex && message.type === "user",
  );
  const turn = messages.slice(promptIndex + 1, nextUserIndex < 0 ? undefined : nextUserIndex);
  return turn.some((message) => message.type === "assistant" && message.id === assistantID);
}

function replyAfterPrompt(
  messages: Awaited<ReturnType<ReturnType<typeof OpenCode.make>["message"]["list"]>>["data"],
  promptID: string,
) {
  const promptIndex = messages.findIndex(
    (message) => message.type === "user" && message.id === promptID,
  );
  if (promptIndex < 0) return null;
  const nextUserIndex = messages.findIndex(
    (message, index) => index > promptIndex && message.type === "user",
  );
  const assistants = messages
    .slice(promptIndex + 1, nextUserIndex < 0 ? undefined : nextUserIndex)
    .filter((message) => message.type === "assistant");
  const final =
    [...assistants].reverse().find((message) => message.finish === "stop") ?? assistants.at(-1);
  if (!final || final.type !== "assistant") return null;
  return final.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

function toolCallsAfterPrompt(
  messages: Awaited<ReturnType<ReturnType<typeof OpenCode.make>["message"]["list"]>>["data"],
  promptID: string,
) {
  const promptIndex = messages.findIndex(
    (message) => message.type === "user" && message.id === promptID,
  );
  if (promptIndex < 0) return [];
  const nextUserIndex = messages.findIndex(
    (message, index) => index > promptIndex && message.type === "user",
  );
  return messages
    .slice(promptIndex + 1, nextUserIndex < 0 ? undefined : nextUserIndex)
    .flatMap((message) =>
      message.type === "assistant"
        ? message.content.flatMap((part) =>
            part.type === "tool"
              ? [
                  {
                    assistantMessageID: message.id,
                    call: {
                      id: part.id,
                      name: part.name,
                      status:
                        part.state.status === "completed"
                          ? ("completed" as const)
                          : part.state.status === "error"
                            ? ("failed" as const)
                            : ("running" as const),
                    },
                  },
                ]
              : [],
          )
        : [],
    );
}

function toolEvent(event: Event) {
  if (
    event.type === "session.tool.input.started" ||
    event.type === "session.tool.called" ||
    event.type === "session.tool.success" ||
    event.type === "session.tool.failed"
  )
    return {
      assistantMessageID: event.data.assistantMessageID,
      call: {
        id: event.data.id,
        name: event.type === "session.tool.input.started" ? event.data.name : "",
        status:
          event.type === "session.tool.success"
            ? ("completed" as const)
            : event.type === "session.tool.failed"
              ? ("failed" as const)
              : ("running" as const),
      },
    };
}

function belongsToSession(event: Event, sessionID: string) {
  if (event.type === "server.connected") return false;
  if (event.type === "form.created") return event.data.form.sessionID === sessionID;
  return "sessionID" in event.data && event.data.sessionID === sessionID;
}

function asError(error: unknown) {
  return error instanceof Error ? error : new Error("OpenCode conversation request failed.");
}
