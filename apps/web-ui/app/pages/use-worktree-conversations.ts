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
    const controller = new AbortController();
    void refresh(controller.signal);
    const timer = window.setInterval(() => void refresh(), 1200);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [enabled, worktree, refresh]);

  const create = useCallback(async () => {
    if (!worktree) return null;
    const conversation = await createConversation(project, worktree, branch);
    setConversations((current) => [...current, conversation]);
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
