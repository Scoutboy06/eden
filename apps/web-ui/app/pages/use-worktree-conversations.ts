import { useCallback, useEffect, useState } from "react";

import {
  createConversation,
  listConversations,
  setConversationHidden,
  type Conversation,
} from "@/pages/conversations";

export function useWorktreeConversations(
  project: string,
  worktree: string | undefined,
  branch: string | null,
  enabled: boolean,
) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [hiddenConversations, setHiddenConversations] = useState<Conversation[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      if (!worktree) return;
      try {
        const result = await listConversations(project, worktree, branch, signal);
        setConversations(result.conversations);
        setHiddenConversations(result.hiddenConversations);
        setError(null);
      } catch (cause) {
        if (!signal?.aborted)
          setError(cause instanceof Error ? cause.message : "Could not load conversations.");
      }
    },
    [project, worktree, branch],
  );

  useEffect(() => {
    if (!enabled || !worktree) return;
    let disposed = false;
    let socket: WebSocket | undefined;
    let reconnectTimer: number | undefined;
    let reconnectDelay = 250;
    const connect = () => {
      if (disposed) return;
      socket = new WebSocket(
        `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/conversations/socket`,
      );
      socket.addEventListener("open", () => {
        reconnectDelay = 250;
        socket?.send(JSON.stringify({ type: "subscribe", project, worktree, branch }));
      });
      socket.addEventListener("message", (event) => {
        try {
          const message = JSON.parse(String(event.data)) as {
            type?: string;
            conversations?: Conversation[];
            hiddenConversations?: Conversation[];
          };
          if (message.type !== "snapshot") return;
          setConversations(message.conversations ?? []);
          setHiddenConversations(message.hiddenConversations ?? []);
          setError(null);
        } catch {
          setError("Could not read conversation updates.");
        }
      });
      socket.addEventListener("close", () => {
        if (disposed) return;
        reconnectTimer = window.setTimeout(connect, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, 5000);
      });
      socket.addEventListener("error", () => socket?.close());
    };
    connect();
    return () => {
      disposed = true;
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, [enabled, project, worktree, branch]);

  const create = useCallback(async () => {
    if (!worktree) return null;
    const conversation = await createConversation(project, worktree, branch);
    setConversations((current) =>
      current.some(({ id }) => id === conversation.id) ? current : [...current, conversation],
    );
    return conversation;
  }, [project, worktree, branch]);

  const setHidden = useCallback(
    async (id: string, hidden: boolean) => {
      if (!worktree) return null;
      const conversation = await setConversationHidden(id, hidden, project, worktree, branch);
      await refresh();
      return conversation;
    },
    [project, worktree, branch, refresh],
  );

  return { conversations, hiddenConversations, error, refresh, create, setHidden };
}
