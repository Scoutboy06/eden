export type ConversationMessage = {
  role: "user" | "assistant";
  text: string;
  createdAt: number;
};

export type Conversation = {
  id: string;
  project: string;
  worktree: string;
  branch: string | null;
  status: "ready" | "active" | "blocked" | "incomplete";
  messages: ConversationMessage[];
  updatedAt: number;
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
  return (await response.json()).conversations as Conversation[];
}

export async function createConversation(project: string, worktree: string, branch: string | null) {
  const response = await fetch("/api/conversations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ project, worktree, branch }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? "Could not create conversation.");
  return result.conversation as Conversation;
}

export async function sendConversationMessage(id: string, text: string) {
  const response = await fetch(`/api/conversations/${encodeURIComponent(id)}/send`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? "Could not send message.");
  return result.conversation as Conversation;
}
