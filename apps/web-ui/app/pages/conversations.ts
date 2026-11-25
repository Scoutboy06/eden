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
  hidden: boolean;
  status: "ready" | "active" | "blocked" | "incomplete";
  messages: ConversationMessage[];
  approvals?: {
    id: string;
    action: string;
    resources: string[];
    message?: string;
  }[];
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
  return (await response.json()) as {
    conversations: Conversation[];
    hiddenConversations: Conversation[];
  };
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

export async function setConversationHidden(
  id: string,
  hidden: boolean,
  project: string,
  worktree: string,
  branch: string | null,
) {
  const response = await fetch(
    `/api/conversations/${encodeURIComponent(id)}/${hidden ? "close" : "reopen"}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project, worktree, branch }),
    },
  );
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? "Could not update conversation visibility.");
  return result.conversation as Conversation;
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
  const response = await fetch(
    `/api/conversations/${encodeURIComponent(conversationID)}/permissions/${encodeURIComponent(requestID)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision }),
    },
  );
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? "Could not answer this permission request.");
}
