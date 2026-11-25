import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
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
  | { type: "blocked" }
  | { type: "settled"; reply: string };

export type ObservationEvent =
  | { type: "text"; assistantMessageID: string; delta: string }
  | { type: "blocked" }
  | { type: "settled"; reply: string };

let waking: Promise<Endpoint> | undefined;

export type OpenCodeConversationClient = {
  prepare(directory: string): Promise<void>;
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
          if (state.reply === null)
            throw new Error("The OpenCode prompt has no authoritative reply.");
          onEvent({ type: "settled", reply: state.reply });
          return;
        }

        for await (const event of { [Symbol.asyncIterator]: () => iterator }) {
          if (!belongsToSession(event, sessionID)) continue;
          if (event.type === "session.text.started") {
            const messages = await listMessages(client, sessionID);
            if (assistantFollowsPrompt(messages, promptID, event.data.assistantMessageID))
              assistantIDs.add(event.data.assistantMessageID);
          }
          if (
            event.type === "session.text.delta" &&
            assistantIDs.has(event.data.assistantMessageID)
          )
            onEvent({
              type: "text",
              assistantMessageID: event.data.assistantMessageID,
              delta: event.data.delta,
            });
          if (isBlockedEvent(event)) onEvent({ type: "blocked" });
          if (isSettledEvent(event)) {
            const result = await reconcile(client, sessionID, promptID);
            if (!result.active && result.reply !== null) {
              onEvent({ type: "settled", reply: result.reply });
              return;
            }
            if (!result.active)
              throw new Error("OpenCode settled without an authoritative reply for this prompt.");
          }
        }
        throw new Error("OpenCode event stream ended before the turn settled.");
      } finally {
        controller.abort();
      }
    },
    async send(sessionID, directory, promptID, text, observe) {
      const endpoint = await discoverOrWake(discover, options);
      const controller = new AbortController();
      const client = await makeClient(endpoint, directory);
      const iterator = subscribe(client, controller.signal)[Symbol.asyncIterator]();

      let acceptedUserID: string | undefined;
      let acceptedAt: number | undefined;
      const queued: Event[] = [];
      const pendingText = new Map<string, string>();
      const assistantIDs = new Set<string>();
      let resolveTurn!: (reply: string) => void;
      let rejectTurn!: (error: Error) => void;
      const completed = new Promise<string>((resolve, reject) => {
        resolveTurn = resolve;
        rejectTurn = reject;
      });
      // Stream EOF may reject this before session.prompt returns; mark it handled now,
      // while preserving the rejection for the send path's later await.
      void completed.catch(() => {});
      async function processEvent(event: Event) {
        if (event.type === "server.connected") return;
        if (!belongsToSession(event, sessionID)) return;
        if (acceptedAt !== undefined && event.created < acceptedAt) return;
        if (event.type === "session.text.started") {
          const messages = await listMessages(client, sessionID);
          if (assistantFollowsPrompt(messages, acceptedUserID!, event.data.assistantMessageID)) {
            assistantIDs.add(event.data.assistantMessageID);
            const buffered = pendingText.get(event.data.assistantMessageID);
            if (buffered) {
              observe?.({
                type: "text",
                assistantMessageID: event.data.assistantMessageID,
                delta: buffered,
              });
              pendingText.delete(event.data.assistantMessageID);
            }
          }
        }
        if (event.type === "session.text.delta") {
          if (assistantIDs.has(event.data.assistantMessageID)) {
            observe?.({
              type: "text",
              assistantMessageID: event.data.assistantMessageID,
              delta: event.data.delta,
            });
          } else {
            pendingText.set(
              event.data.assistantMessageID,
              (pendingText.get(event.data.assistantMessageID) ?? "") + event.data.delta,
            );
          }
        }
        if (isBlockedEvent(event)) observe?.({ type: "blocked" });
        if (isSettledEvent(event)) {
          const reply = replyAfterPrompt(await listMessages(client, sessionID), acceptedUserID!);
          if (reply === null) {
            rejectTurn(new Error("OpenCode settled without an assistant reply for this prompt."));
            return;
          }
          observe?.({ type: "settled", reply });
          resolveTurn(reply);
        }
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

function belongsToSession(event: Event, sessionID: string) {
  if (event.type === "server.connected") return false;
  if (event.type === "form.created") return event.data.form.sessionID === sessionID;
  return "sessionID" in event.data && event.data.sessionID === sessionID;
}

function isBlockedEvent(event: Event) {
  return (
    event.type === "permission.asked" ||
    (event.type === "form.created" && Boolean(event.data.form.sessionID))
  );
}

function isSettledEvent(
  event: Event,
): event is Extract<Event, { type: (typeof settleEvents)[number] }> {
  return settleEvents.includes(event.type as (typeof settleEvents)[number]);
}

function asError(error: unknown) {
  return error instanceof Error ? error : new Error("OpenCode conversation request failed.");
}
