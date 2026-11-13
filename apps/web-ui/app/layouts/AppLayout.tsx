import { useRef, useState, type MouseEvent, type PointerEvent } from "react";
import { Outlet, useMatch, useParams } from "react-router-dom";

import { ActivityBar } from "@/components/activity-bar";
import { TasksSidebar } from "@/components/tasks-sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useWorktrees } from "@/pages/use-worktrees";
import { useWorktreeSelection } from "@/pages/use-worktree-selection";

const DRAG_THRESHOLD = 24;

export function AppLayout() {
  const isDoingPage = useMatch("/p/:project/doing") !== null;
  const { project = "" } = useParams();
  const worktreeData = useWorktrees(project);
  const selection = useWorktreeSelection(project, worktreeData.worktrees);
  const [tasksOpen, setTasksOpen] = useState(
    () => typeof window === "undefined" || window.matchMedia("(min-width: 768px)").matches,
  );
  const pointerStartRef = useRef<{ x: number; open: boolean } | null>(null);
  const didDragRef = useRef(false);
  const suppressClickRef = useRef(false);

  function toggleSidebar() {
    setTasksOpen((open) => !open);
  }

  function handlePointerDown(event: PointerEvent<HTMLButtonElement>) {
    if (event.button !== 0) return;

    pointerStartRef.current = { x: event.clientX, open: tasksOpen };
    didDragRef.current = false;
    suppressClickRef.current = false;
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handlePointerMove(event: PointerEvent<HTMLButtonElement>) {
    const start = pointerStartRef.current;
    if (!start) return;

    const delta = event.clientX - start.x;
    if (Math.abs(delta) < DRAG_THRESHOLD) return;

    didDragRef.current = true;

    if ((!start.open && delta > 0) || (start.open && delta < 0)) {
      setTasksOpen(!start.open);
    }
  }

  function handlePointerUp(event: PointerEvent<HTMLButtonElement>) {
    pointerStartRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    if (didDragRef.current) {
      suppressClickRef.current = true;
    }
    didDragRef.current = false;
  }

  function handlePointerCancel() {
    pointerStartRef.current = null;
    didDragRef.current = false;
    suppressClickRef.current = false;
  }

  function handleClick(event: MouseEvent<HTMLButtonElement>) {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }

    if (event.detail <= 1) toggleSidebar();
  }

  return (
    <TooltipProvider>
      <div className="relative flex h-svh overflow-hidden">
        <ActivityBar />
        <div
          hidden={!isDoingPage}
          className={`relative h-svh shrink-0 transition-[width] duration-200 ${tasksOpen ? "w-64 sm:w-72 lg:w-80" : "w-0"}`}
        >
          <TasksSidebar
            open={isDoingPage && tasksOpen}
            worktrees={worktreeData.worktrees}
            loading={worktreeData.loading}
            stale={worktreeData.stale}
            error={worktreeData.error}
            refreshedAt={worktreeData.refreshedAt}
            refresh={worktreeData.refresh}
            selectedWorktreeKey={selection.key}
            onSelectWorktree={selection.select}
          />
          <button
            type="button"
            aria-label={tasksOpen ? "Hide worktrees sidebar" : "Show worktrees sidebar"}
            aria-controls="worktrees-sidebar"
            aria-expanded={tasksOpen}
            title={tasksOpen ? "Hide worktrees sidebar" : "Show worktrees sidebar"}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerCancel}
            onClick={handleClick}
            className="group/sidebar-edge absolute inset-y-0 left-full z-20 h-full w-2 touch-none cursor-pointer rounded-none border-0 bg-transparent p-0 outline-none"
          >
            <span
              aria-hidden="true"
              className="absolute inset-y-0 left-0 w-px bg-sidebar-border transition-colors group-hover/sidebar-edge:bg-muted-foreground/50"
            />
            <span
              aria-hidden="true"
              className="absolute left-0 top-1/2 flex size-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-sidebar-border bg-background text-muted-foreground shadow-sm transition-colors group-hover/sidebar-edge:border-muted-foreground/50 group-focus-visible/sidebar-edge:outline-2 group-focus-visible/sidebar-edge:outline-offset-2 group-focus-visible/sidebar-edge:outline-current"
            >
              <svg viewBox="0 0 16 16" className="size-3.5" fill="none">
                {tasksOpen ? (
                  <path
                    d="m10 3-5 5 5 5"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                ) : (
                  <path
                    d="m6 3 5 5-5 5"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                )}
              </svg>
            </span>
          </button>
        </div>
        <main
          className={`flex min-h-0 min-w-0 flex-1 flex-col overflow-auto ${isDoingPage ? "" : "p-4"}`}
        >
          <Outlet
            context={{
              project,
              worktrees: worktreeData.worktrees,
              selectedWorktreeKey: selection.key,
            }}
          />
        </main>
      </div>
    </TooltipProvider>
  );
}
