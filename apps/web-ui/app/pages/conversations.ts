import type { Conversation } from "../../conversation-contract";

export type { Conversation, ConversationForm } from "../../conversation-contract";

export type ConversationModel = {
  key: string;
  id: string;
  providerID: string;
  name: string;
  group?: { key: string; label: string };
};

export async function listConversations(
  project: string,
  worktree: string,
  branch: string | null,
  signal?: AbortSignal,
) {
  const query = new URLSearchParams({ project, worktree, branch: branch ?? "" });
  const response = await fetch(`/api/conversations?${query}`, { signal });
  if (!response.ok) throw new Error("Could not load OpenCode conversations.");
  return (await response.json()) as {
    conversations: Conversation[];
    hiddenConversations: Conversation[];
  };
}

export async function createConversation(project: string, worktree: string, branch: string | null) {
  const result = await postConversation<{ conversation: Conversation }>("/api/conversations", {
    project,
    worktree,
    branch,
  });
  return result.conversation;
}

export async function listConversationModels(id: string) {
  const response = await fetch(`/api/conversations/${encodeURIComponent(id)}/models`);
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? "Could not load available OpenCode models.");
  return result.models as ConversationModel[];
}

export async function sendConversationMessage(id: string, text: string, modelKey?: string | null) {
  const result = await postConversation<{ conversation: Conversation }>(
    `/api/conversations/${encodeURIComponent(id)}/send`,
    { text, ...(modelKey !== undefined ? { modelKey } : {}) },
    "Could not send message.",
  );
  return result.conversation;
}

export async function setConversationHidden(
  id: string,
  hidden: boolean,
  project: string,
  worktree: string,
  branch: string | null,
) {
  const result = await postConversation<{ conversation: Conversation }>(
    `/api/conversations/${encodeURIComponent(id)}/${hidden ? "close" : "reopen"}`,
    { project, worktree, branch },
    "Could not update conversation visibility.",
  );
  return result.conversation;
}

export async function stopConversation(id: string) {
  const response = await fetch(`/api/conversations/${encodeURIComponent(id)}/stop`, {
    method: "POST",
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? "Could not stop this reply.");
}

export async function replyToPermission(
  conversationID: string,
  requestID: string,
  decision: "once" | "always" | "reject",
) {
  await postConversation(
    `/api/conversations/${encodeURIComponent(conversationID)}/permissions/${encodeURIComponent(requestID)}`,
    { decision },
    "Could not answer this permission request.",
  );
}

export async function replyToForm(
  conversationID: string,
  formID: string,
  answer: Record<string, string | number | boolean>,
) {
  await postConversation(
    `/api/conversations/${encodeURIComponent(conversationID)}/forms/${encodeURIComponent(formID)}`,
    { answer },
    "Could not answer this OpenCode form.",
  );
}

async function postConversation<Result extends Record<string, unknown> = Record<string, unknown>>(
  path: string,
  body: Record<string, unknown>,
  fallback = "Could not process conversation request.",
): Promise<Result> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = (await response.json()) as Result;
  if (!response.ok)
    throw new Error(
      "error" in result && typeof result.error === "string" ? result.error : fallback,
    );
  return result;
}
