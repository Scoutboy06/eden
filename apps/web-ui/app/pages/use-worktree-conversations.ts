import { useCallback, useEffect, useState } from "react";

import { createConversation, listConversations, type Conversation } from "@/pages/conversations";

export function useWorktreeConversations(
  project: string,
  worktree: string | undefined,
  branch: string | null,
  enabled: boolean,
) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      if (!worktree) return;
      try {
        setConversations(await listConversations(project, worktree, branch, signal));
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

  return { conversations, error, refresh, create };
}
