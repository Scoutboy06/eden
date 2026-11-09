import { createContext, useContext, type MouseEvent, type ReactNode } from "react";

export const TaskOpeningContext = createContext<
  ((id: string, trigger: HTMLElement) => void) | null
>(null);

export function TaskTitle({ id, children }: { id: string; children: ReactNode }) {
  const open = useContext(TaskOpeningContext);
  return open ? (
    <button
      type="button"
      data-task-open={id}
      className="w-full cursor-pointer truncate rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onClick={(event) => {
        event.stopPropagation();
        open(id, event.currentTarget);
      }}
    >
      {children}
    </button>
  ) : (
    children
  );
}

export function useTaskClick(id: string) {
  const open = useContext(TaskOpeningContext);
  return (event: MouseEvent) => {
    const target = event.target as HTMLElement;
    if (target.closest("button, a, input, [role=button]")) return;

    const row = event.currentTarget as HTMLElement;
    const trigger = row.querySelector<HTMLElement>("[data-task-open]") ?? row;
    open?.(id, trigger);
  };
}
