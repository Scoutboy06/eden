import { useEffect, useRef, useState } from "react";

import { randomId } from "@/pages/random-id";
import { sendTerminal, subscribeTerminals } from "@/pages/terminal-socket";

export function useWorktreeTerminals(
  project: string,
  worktree: string | undefined,
  branch: string | null,
  selected: boolean,
  onCreated: (id: string) => void,
) {
  const [sessions, setSessions] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const pending = useRef(new Set<string>());
  const onCreatedRef = useRef(onCreated);
  onCreatedRef.current = onCreated;

  useEffect(() => {
    if (!selected || !worktree) return;
    const scope = { project, worktree, branch };
    const unsubscribe = subscribeTerminals((message) => {
      switch (message.type) {
        case "connected":
          setConnected(true);
          sendTerminal({ type: "list", ...scope });
          break;
        case "disconnected":
          setConnected(false);
          pending.current.clear();
          break;
        case "sessions":
          if (
            message.project === project &&
            message.worktree === worktree &&
            message.branch === branch
          )
            setSessions((message.items as { id: string }[]).map(({ id }) => id));
          break;
        case "created":
        case "error":
          if (typeof message.requestId !== "string" || !pending.current.delete(message.requestId))
            return;
          if (message.type === "error") setError(String(message.error));
          else if (typeof message.sessionId === "string") {
            const id = message.sessionId;
            setSessions((current) => (current.includes(id) ? current : [...current, id]));
            onCreatedRef.current(id);
          }
      }
    });
    return () => {
      unsubscribe();
      setConnected(false);
      pending.current.clear();
      sendTerminal({ type: "unwatch" });
    };
  }, [project, worktree, branch, selected]);

  function create() {
    const requestId = randomId();
    setError(null);
    if (sendTerminal({ type: "create", project, worktree, branch, requestId })) {
      pending.current.add(requestId);
    } else setError("Terminal service is reconnecting. Try again in a moment.");
  }

  function end(sessionId: string) {
    if (!window.confirm("End this shared terminal? Its shell will stop for everyone.")) return;
    setError(null);
    if (!sendTerminal({ type: "end", sessionId }))
      setError("Terminal service is reconnecting. Try again in a moment.");
  }

  return { sessions, connected, error, create, end };
}
