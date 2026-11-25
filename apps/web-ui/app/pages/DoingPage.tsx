import { lazy, Suspense, useCallback, useRef, useState } from "react";
import { useOutletContext } from "react-router-dom";

import { CIStatus } from "@/components/ci-status";
import { LauncherIcon } from "@/components/launcher-icon";
import type { Task } from "@/components/tasks-sidebar-data";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { formatPullRequestReference } from "@/pages/prs-data";
import { createWorktreeDemoTask } from "@/pages/worktree-demo";
import { worktreeSelectionKey } from "@/pages/worktree-selection";
import type { WorktreeProjection } from "@/pages/worktrees";
import { useWorktreeDiff } from "@/pages/use-worktree-diff";
import { useWorktreeTerminals } from "@/pages/use-worktree-terminals";
import { useWorktreeConversations } from "@/pages/use-worktree-conversations";
import { OpenCodeConversationPane } from "@/pages/OpenCodeConversationPane";
import { agentHarnesses, isAgentHarness, type AgentHarness } from "../../shared/agent-harnesses";

const TerminalPane = lazy(() =>
  import("@/pages/TerminalPane").then((module) => ({ default: module.TerminalPane })),
);
const DiffViewer = lazy(() =>
  import("@/components/diff-viewer").then((module) => ({ default: module.DiffViewer })),
);

export function DoingPage() {
  const { project, worktrees, selectedWorktreeKey } = useOutletContext<{
    project: string;
    worktrees: WorktreeProjection[];
    selectedWorktreeKey: string | null;
  }>();
  const selectedWorktree = worktrees.find(
    (worktree) => worktreeSelectionKey(worktree) === selectedWorktreeKey,
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {selectedWorktree ? (
        worktrees.map((worktree) => {
          const task = createWorktreeDemoTask(worktree, project);
          const selected = worktreeSelectionKey(worktree) === selectedWorktreeKey;

          return (
            <div
              key={task.key}
              hidden={!selected}
              className={selected ? "flex min-h-0 flex-1 flex-col" : "hidden"}
            >
              <Workspace task={task} project={project} selected={selected} />
            </div>
          );
        })
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center p-8">
          <EmptyPanel
            title="Select a worktree"
            description="Choose a live local worktree from the sidebar to open its demo details."
          />
        </div>
      )}
    </div>
  );
}

function Workspace({
  task,
  project,
  selected,
}: {
  task: Task;
  project: string;
  selected: boolean;
}) {
  const [selectedTab, setSelectedTab] = useState("reviews");
  const [conversationError, setConversationError] = useState<string | null>(null);
  const focusSession = useRef<string | null>(null);
  const launching = useRef(false);
  const { sessions, availableHarnesses, connected, error, create, end } = useWorktreeTerminals(
    project,
    task.worktree?.name,
    task.worktree?.branch ?? null,
    selected,
    (id) => {
      focusSession.current = id;
      setSelectedTab(id);
    },
  );
  const conversationsState = useWorktreeConversations(
    project,
    task.worktree?.name,
    task.worktree?.branch ?? null,
    selected,
  );
  const diffState = useWorktreeDiff(
    project,
    task.worktree?.name,
    task.worktree?.branch ?? null,
    selected,
  );
  const claimLaunchFocus = useCallback((id: string) => {
    if (focusSession.current !== id) return false;
    focusSession.current = null;
    return true;
  }, []);

  function launch(harness?: AgentHarness) {
    launching.current = create(harness);
  }

  async function launchConversation() {
    try {
      const conversation = await conversationsState.create();
      if (conversation) setSelectedTab(conversation.id);
    } catch {
      setConversationError("Could not create an OpenCode conversation.");
    }
  }

  async function closeConversation(id: string) {
    try {
      await conversationsState.setHidden(id, true);
      setConversationError(null);
    } catch {
      setConversationError("Could not close the OpenCode conversation.");
    }
  }

  async function reopenConversation(id: string) {
    try {
      const conversation = await conversationsState.setHidden(id, false);
      if (conversation) setSelectedTab(id);
      setConversationError(null);
    } catch {
      setConversationError("Could not reopen the OpenCode conversation.");
    }
  }

  function restoreMenuFocus() {
    const shouldRestore = !launching.current;
    launching.current = false;
    return shouldRestore;
  }
  let terminalNumber = 0;
  const terminalTabs = sessions.map(({ id, harness }) => ({
    id,
    harness,
    title: isAgentHarness(harness) ? agentHarnesses[harness].title : `Terminal ${++terminalNumber}`,
    kind: "terminal" as const,
  }));
  const conversationTabs = conversationsState.conversations.map((conversation, index) => ({
    id: conversation.id,
    title: `OpenCode conversation ${index + 1}`,
    kind: "conversation" as const,
  }));
  const tabs = [...terminalTabs, ...conversationTabs];
  const active =
    selectedTab === "reviews" || tabs.some(({ id }) => id === selectedTab) ? selectedTab : "diff";

  return (
    <section aria-label={`${task.title} workspace`} className="flex min-h-0 flex-1 flex-col">
      <header className="flex min-h-16 shrink-0 items-center justify-between gap-4 border-b border-border px-6 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>Branch</span>
            <span aria-hidden="true">/</span>
            <span className="truncate font-mono">{task.worktree?.branch ?? "Detached HEAD"}</span>
          </div>
          <h1 className="mt-1 truncate text-sm font-semibold">{task.worktree?.name}</h1>
        </div>
        <span className="shrink-0 rounded border border-border px-2 py-1 text-[10px] text-muted-foreground">
          Local worktree
        </span>
      </header>
      <Tabs
        value={active}
        onValueChange={(value) => setSelectedTab(String(value))}
        className="min-h-0 flex-1 gap-0"
      >
        <div className="flex shrink-0 items-center border-b border-border bg-muted/20 px-4">
          <div className="min-w-0 overflow-x-auto">
            <TabsList variant="line" className="h-11! justify-start gap-0 p-0">
              <TabsTrigger
                value="reviews"
                className="h-11 shrink-0 flex-none rounded-none px-4 after:bottom-0!"
              >
                Reviews
                {task.reviewCount ? (
                  <span className="rounded bg-muted px-1.5 font-mono text-[10px]">
                    {task.reviewCount}
                  </span>
                ) : null}
              </TabsTrigger>
              <TabsTrigger
                value="diff"
                className="h-11 shrink-0 flex-none rounded-none px-4 after:bottom-0!"
              >
                Diff
              </TabsTrigger>
              {tabs.map((tab) => (
                <div key={tab.id} className="relative flex shrink-0 items-center">
                  <TabsTrigger
                    value={tab.id}
                    className="h-11 flex-none rounded-none pr-8 pl-4 after:bottom-0!"
                  >
                    <span aria-hidden="true" className="font-mono text-xs text-muted-foreground">
                      {tab.kind === "conversation" ? "✳" : tab.harness ? "◉" : ">_"}
                    </span>
                    <span className="max-w-40 truncate">{tab.title}</span>
                  </TabsTrigger>
                  {tab.kind === "terminal" ? (
                    <button
                      type="button"
                      aria-label={`Close ${tab.title}`}
                      onClick={() => end(tab.id)}
                      className="absolute right-1.5 rounded px-1 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
                    >
                      ×
                    </button>
                  ) : (
                    <button
                      type="button"
                      aria-label={`Close ${tab.title}`}
                      onClick={() => void closeConversation(tab.id)}
                      className="absolute right-1.5 rounded px-1 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
                    >
                      ×
                    </button>
                  )}
                </div>
              ))}
            </TabsList>
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label="New session tab"
              className="ml-2 flex size-7 shrink-0 items-center justify-center rounded text-lg text-muted-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
            >
              +
            </DropdownMenuTrigger>
            <DropdownMenuContent finalFocus={restoreMenuFocus}>
              <DropdownMenuItem onClick={() => void launchConversation()}>
                <span aria-hidden="true">✳</span>
                OpenCode conversation
              </DropdownMenuItem>
              {conversationsState.hiddenConversations.length > 0 ? (
                <>
                  <DropdownMenuSeparator />
                  {conversationsState.hiddenConversations.map((conversation, index) => (
                    <DropdownMenuItem
                      key={conversation.id}
                      onClick={() => void reopenConversation(conversation.id)}
                    >
                      Reopen OpenCode conversation {index + 1}
                    </DropdownMenuItem>
                  ))}
                </>
              ) : null}
              <DropdownMenuSeparator />
              {Object.keys(agentHarnesses)
                .filter(isAgentHarness)
                .map((harness) => {
                  const { title, executable } = agentHarnesses[harness];
                  const label = (
                    <>
                      <LauncherIcon harness={harness} />
                      {title}
                    </>
                  );
                  if (connected && !availableHarnesses.includes(harness))
                    return (
                      <TooltipProvider key={harness} delay={550} timeout={0}>
                        <Tooltip>
                          <TooltipTrigger render={<div />}>
                            <DropdownMenuItem disabled>{label}</DropdownMenuItem>
                          </TooltipTrigger>
                          <TooltipContent side="right">
                            {executable} was not found on the Eden server’s PATH.
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    );
                  return (
                    <DropdownMenuItem
                      key={harness}
                      disabled={!connected}
                      onClick={() => launch(harness)}
                    >
                      {label}
                    </DropdownMenuItem>
                  );
                })}
              <DropdownMenuSeparator />
              <DropdownMenuItem disabled={!connected} onClick={() => launch()}>
                <LauncherIcon />
                Terminal
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        {(error || conversationError || conversationsState.error) && (
          <p role="alert" className="px-4 py-2 text-sm text-destructive">
            {error ?? conversationError ?? conversationsState.error}
          </p>
        )}
        <TabsContent value="reviews" className="overflow-y-auto p-6">
          <Reviews task={task} />
        </TabsContent>
        <TabsContent value="diff" className="overflow-y-auto p-6">
          <Diff task={task} diffState={diffState} />
        </TabsContent>
        {tabs.map((tab) => (
          <TabsContent
            key={tab.id}
            value={tab.id}
            className="relative flex min-h-0 flex-1 flex-col overflow-hidden"
          >
            {tab.kind === "conversation" ? (
              selected && active === tab.id ? (
                <OpenCodeConversationPane
                  conversation={conversationsState.conversations.find(({ id }) => id === tab.id)!}
                  refresh={conversationsState.refresh}
                />
              ) : null
            ) : selected && active === tab.id ? (
              <Suspense
                fallback={
                  <div className="p-4 text-sm text-muted-foreground">Loading terminal…</div>
                }
              >
                <TerminalPane sessionId={tab.id} claimLaunchFocus={claimLaunchFocus} />
              </Suspense>
            ) : null}
          </TabsContent>
        ))}
      </Tabs>
    </section>
  );
}

function Reviews({ task }: { task: Task }) {
  if (!task.pullRequest)
    return (
      <EmptyPanel
        title="No pull request yet"
        description="Review feedback for this workspace will appear here once a pull request is linked."
      />
    );

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">
            Pull request{" "}
            {formatPullRequestReference(task.pullRequest.provider, task.pullRequest.number)}
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">Review feedback for this workspace</p>
        </div>
        {task.ci ? <CIStatus status={task.ci} /> : null}
      </div>
      {task.reviewCount ? (
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            {task.reviewCount} unresolved comments · illustrative feedback
          </p>
          {[
            "Should the social title use the translated page title as well?",
            "Can we cover the fallback title with a test?",
          ].map((text, index) => (
            <article key={text} className="rounded-lg border border-border bg-card p-4">
              <div className="flex items-center gap-2 text-xs">
                <span className="font-medium">Reviewer</span>
                <span className="text-muted-foreground">Example thread {index + 1}</span>
              </div>
              <p className="mt-3 text-sm leading-relaxed">{text}</p>
            </article>
          ))}
        </div>
      ) : (
        <EmptyPanel
          title="No review comments"
          description="There are no review comments in the demo data for this task."
        />
      )}
    </div>
  );
}

function Diff({ task, diffState }: { task: Task; diffState: ReturnType<typeof useWorktreeDiff> }) {
  if (!task.worktree)
    return (
      <EmptyPanel
        title="No worktree attached"
        description="A worktree is needed to view changes for this task."
      />
    );

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold">Working tree changes</h2>
          <p className="mt-1 font-mono text-xs text-muted-foreground">
            {task.worktree.branch ?? task.worktree.name} · compared with{" "}
            {diffState.diff?.base ?? "HEAD"}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Includes staged, unstaged, and untracked changes; excludes commit history.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void diffState.refresh()}
          disabled={diffState.loading}
          className="shrink-0 rounded border border-border px-3 py-1.5 text-xs hover:bg-muted disabled:opacity-50"
        >
          {diffState.loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      {diffState.error ? (
        <p role="alert" className="text-sm text-destructive">
          {diffState.error}
        </p>
      ) : null}
      {diffState.loading && !diffState.diff ? (
        <EmptyPanel
          title="Loading changes"
          description="Reading staged, unstaged, and untracked files from the selected worktree."
        />
      ) : diffState.diff ? (
        <Suspense
          fallback={<div className="p-4 text-sm text-muted-foreground">Loading diff viewer…</div>}
        >
          <DiffViewer
            files={diffState.diff.files}
            omittedFileCount={diffState.diff.omittedFileCount}
          />
        </Suspense>
      ) : null}
    </div>
  );
}

function EmptyPanel({ title, description }: { title: string; description: string }) {
  return (
    <div className="flex min-h-64 flex-col items-center justify-center rounded-lg border border-dashed border-border p-8 text-center">
      <h3 className="text-sm font-medium">{title}</h3>
      <p className="mt-2 max-w-sm text-xs leading-relaxed text-muted-foreground">{description}</p>
    </div>
  );
}
