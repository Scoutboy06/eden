import { lazy, Suspense, useRef, useState } from "react";
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
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
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
  const [hiddenConversationsOpen, setHiddenConversationsOpen] = useState(false);
  const terminalState = useWorkspaceTerminals(project, task, selected, setSelectedTab);
  const {
    sessions,
    availableHarnesses,
    connected,
    error,
    end,
    launch,
    claimLaunchFocus,
    restoreMenuFocus,
  } = terminalState;
  const conversationsState = useWorktreeConversations(
    project,
    task.worktree?.name,
    task.worktree?.branch ?? null,
    selected,
  );
  const { conversationError, launchConversation, closeConversation, reopenConversation } =
    useWorkspaceConversationActions(conversationsState, setSelectedTab, setHiddenConversationsOpen);
  const diffState = useWorktreeDiff(
    project,
    task.worktree?.name,
    task.worktree?.branch ?? null,
    selected && selectedTab === "diff",
  );
  const tabs = createWorkspaceTabs(sessions, conversationsState.conversations);
  const active = getActiveWorkspaceTab(selectedTab, tabs);

  return (
    <section aria-label={`${task.title} workspace`} className="flex min-h-0 flex-1 flex-col">
      <WorkspaceHeader
        task={task}
        hiddenConversations={conversationsState.hiddenConversations}
        hiddenConversationsOpen={hiddenConversationsOpen}
        onHiddenConversationsOpenChange={setHiddenConversationsOpen}
        onReopenConversation={(id) => void reopenConversation(id)}
      />
      <Tabs
        value={active}
        onValueChange={(value) => setSelectedTab(String(value))}
        className="min-h-0 flex-1 gap-0"
      >
        <WorkspaceTabBar
          task={task}
          tabs={tabs}
          connected={connected}
          availableHarnesses={availableHarnesses}
          onCloseTerminal={end}
          onCloseConversation={(id) => void closeConversation(id)}
          onLaunch={launch}
          onLaunchConversation={() => void launchConversation()}
          restoreMenuFocus={restoreMenuFocus}
        />
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
        <WorkspaceSessionContent
          tabs={tabs}
          selected={selected}
          active={active}
          conversations={conversationsState.conversations}
          refreshConversations={conversationsState.refresh}
          claimLaunchFocus={claimLaunchFocus}
        />
      </Tabs>
    </section>
  );
}

function useWorkspaceTerminals(
  project: string,
  task: Task,
  selected: boolean,
  setSelectedTab: (tab: string) => void,
) {
  const focusSession = useRef<string | null>(null);
  const launching = useRef(false);
  const terminalState = useWorktreeTerminals(
    project,
    task.worktree?.name,
    task.worktree?.branch ?? null,
    selected,
    (id) => {
      focusSession.current = id;
      setSelectedTab(id);
    },
  );

  function launch(harness?: AgentHarness) {
    launching.current = terminalState.create(harness);
  }

  function claimLaunchFocus(id: string) {
    if (focusSession.current !== id) return false;
    focusSession.current = null;
    return true;
  }

  function restoreMenuFocus() {
    const shouldRestore = !launching.current;
    launching.current = false;
    return shouldRestore;
  }

  return { ...terminalState, launch, claimLaunchFocus, restoreMenuFocus };
}

function useWorkspaceConversationActions(
  state: ReturnType<typeof useWorktreeConversations>,
  setSelectedTab: (tab: string) => void,
  setHiddenConversationsOpen: (open: boolean) => void,
) {
  const [conversationError, setConversationError] = useState<string | null>(null);

  async function launchConversation() {
    try {
      const conversation = await state.create();
      if (conversation) setSelectedTab(conversation.id);
    } catch {
      setConversationError("Could not create an OpenCode conversation.");
    }
  }

  async function closeConversation(id: string) {
    try {
      await state.setHidden(id, true);
      setConversationError(null);
    } catch {
      setConversationError("Could not close the OpenCode conversation.");
    }
  }

  async function reopenConversation(id: string) {
    try {
      const conversation = await state.setHidden(id, false);
      if (conversation) {
        setSelectedTab(id);
        setHiddenConversationsOpen(false);
      }
      setConversationError(null);
    } catch {
      setConversationError("Could not reopen the OpenCode conversation.");
    }
  }

  return { conversationError, launchConversation, closeConversation, reopenConversation };
}

type WorkspaceTab =
  | { id: string; harness: AgentHarness | undefined; title: string; kind: "terminal" }
  | { id: string; title: string; kind: "conversation" };

function createWorkspaceTabs(
  sessions: ReturnType<typeof useWorktreeTerminals>["sessions"],
  conversations: ReturnType<typeof useWorktreeConversations>["conversations"],
): WorkspaceTab[] {
  let terminalNumber = 0;
  const terminalTabs = sessions.map(({ id, harness }) => ({
    id,
    harness,
    title: isAgentHarness(harness) ? agentHarnesses[harness].title : `Terminal ${++terminalNumber}`,
    kind: "terminal" as const,
  }));
  const conversationTabs = conversations.map((conversation, index) => ({
    id: conversation.id,
    title: `OpenCode conversation ${index + 1}`,
    kind: "conversation" as const,
  }));
  return [...terminalTabs, ...conversationTabs];
}

function getActiveWorkspaceTab(selectedTab: string, tabs: WorkspaceTab[]) {
  return selectedTab === "reviews" || tabs.some(({ id }) => id === selectedTab)
    ? selectedTab
    : "diff";
}

function WorkspaceHeader({
  task,
  hiddenConversations,
  hiddenConversationsOpen,
  onHiddenConversationsOpenChange,
  onReopenConversation,
}: {
  task: Task;
  hiddenConversations: ReturnType<typeof useWorktreeConversations>["hiddenConversations"];
  hiddenConversationsOpen: boolean;
  onHiddenConversationsOpenChange: (open: boolean) => void;
  onReopenConversation: (id: string) => void;
}) {
  return (
    <>
      <header className="flex min-h-16 shrink-0 items-center justify-between gap-4 border-b border-border px-6 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>Branch</span>
            <span aria-hidden="true">/</span>
            <span className="truncate font-mono">{task.worktree?.branch ?? "Detached HEAD"}</span>
          </div>
          <h1 className="mt-1 truncate text-sm font-semibold">{task.worktree?.name}</h1>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            aria-label="Hidden conversations"
            aria-controls="hidden-conversations-panel"
            aria-expanded={hiddenConversationsOpen}
            onClick={() => onHiddenConversationsOpenChange(true)}
            className="rounded border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
          >
            Hidden
            {hiddenConversations.length > 0 ? (
              <span className="ml-1.5 rounded bg-muted px-1.5 font-mono text-[10px]">
                {hiddenConversations.length}
              </span>
            ) : null}
          </button>
          <span className="rounded border border-border px-2 py-1 text-[10px] text-muted-foreground">
            Local worktree
          </span>
        </div>
      </header>
      <Sheet open={hiddenConversationsOpen} onOpenChange={onHiddenConversationsOpenChange}>
        <SheetContent id="hidden-conversations-panel" side="right" className="w-[min(22rem,90vw)]">
          <SheetHeader className="border-b border-border pr-12">
            <SheetTitle>Hidden conversations</SheetTitle>
            <SheetDescription>Reopen an OpenCode conversation for this worktree.</SheetDescription>
          </SheetHeader>
          {hiddenConversations.length ? (
            <div className="flex min-h-0 flex-col overflow-y-auto px-4 pb-4">
              {hiddenConversations.map((conversation, index) => (
                <button
                  key={conversation.id}
                  type="button"
                  onClick={() => onReopenConversation(conversation.id)}
                  className="flex min-h-11 items-center gap-2 rounded px-3 text-left text-sm hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
                >
                  <LauncherIcon harness="opencode" />
                  Reopen OpenCode conversation {index + 1}
                </button>
              ))}
            </div>
          ) : (
            <p className="px-4 text-sm text-muted-foreground">No hidden conversations.</p>
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}

function WorkspaceTabBar({
  task,
  tabs,
  connected,
  availableHarnesses,
  onCloseTerminal,
  onCloseConversation,
  onLaunch,
  onLaunchConversation,
  restoreMenuFocus,
}: {
  task: Task;
  tabs: WorkspaceTab[];
  connected: boolean;
  availableHarnesses: ReturnType<typeof useWorktreeTerminals>["availableHarnesses"];
  onCloseTerminal: (id: string) => void;
  onCloseConversation: (id: string) => void;
  onLaunch: (harness?: AgentHarness) => void;
  onLaunchConversation: () => void;
  restoreMenuFocus: () => boolean;
}) {
  return (
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
            <WorkspaceTabTrigger
              key={tab.id}
              tab={tab}
              onClose={() =>
                tab.kind === "terminal" ? onCloseTerminal(tab.id) : onCloseConversation(tab.id)
              }
            />
          ))}
        </TabsList>
      </div>
      <NewSessionMenu
        connected={connected}
        availableHarnesses={availableHarnesses}
        onLaunch={onLaunch}
        onLaunchConversation={onLaunchConversation}
        restoreMenuFocus={restoreMenuFocus}
      />
    </div>
  );
}

function WorkspaceTabTrigger({ tab, onClose }: { tab: WorkspaceTab; onClose: () => void }) {
  return (
    <div className="relative flex shrink-0 items-center">
      <TabsTrigger value={tab.id} className="h-11 flex-none rounded-none pr-8 pl-4 after:bottom-0!">
        {tab.kind === "conversation" ? (
          <LauncherIcon harness="opencode" />
        ) : (
          <span aria-hidden="true" className="font-mono text-xs text-muted-foreground">
            {tab.harness ? "◉" : ">_"}
          </span>
        )}
        <span className="max-w-40 truncate">{tab.title}</span>
      </TabsTrigger>
      <button
        type="button"
        aria-label={`Close ${tab.title}`}
        onClick={onClose}
        className="absolute right-1.5 rounded px-1 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
      >
        ×
      </button>
    </div>
  );
}

function NewSessionMenu({
  connected,
  availableHarnesses,
  onLaunch,
  onLaunchConversation,
  restoreMenuFocus,
}: {
  connected: boolean;
  availableHarnesses: ReturnType<typeof useWorktreeTerminals>["availableHarnesses"];
  onLaunch: (harness?: AgentHarness) => void;
  onLaunchConversation: () => void;
  restoreMenuFocus: () => boolean;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="New session tab"
        className="ml-2 flex size-7 shrink-0 items-center justify-center rounded text-lg text-muted-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
      >
        +
      </DropdownMenuTrigger>
      <DropdownMenuContent finalFocus={restoreMenuFocus}>
        <DropdownMenuItem onClick={onLaunchConversation}>
          <LauncherIcon harness="opencode" />
          OpenCode conversation
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {Object.keys(agentHarnesses)
          .filter(isAgentHarness)
          .map((harness) => (
            <HarnessMenuItem
              key={harness}
              harness={harness}
              connected={connected}
              available={availableHarnesses.includes(harness)}
              onLaunch={onLaunch}
            />
          ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={!connected} onClick={() => onLaunch()}>
          <LauncherIcon />
          Terminal
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function HarnessMenuItem({
  harness,
  connected,
  available,
  onLaunch,
}: {
  harness: AgentHarness;
  connected: boolean;
  available: boolean;
  onLaunch: (harness?: AgentHarness) => void;
}) {
  const { title, executable } = agentHarnesses[harness];
  const label = (
    <>
      <LauncherIcon harness={harness} />
      {title}
    </>
  );
  if (connected && !available)
    return (
      <TooltipProvider delay={550} timeout={0}>
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
    <DropdownMenuItem disabled={!connected} onClick={() => onLaunch(harness)}>
      {label}
    </DropdownMenuItem>
  );
}

function WorkspaceSessionContent({
  tabs,
  selected,
  active,
  conversations,
  refreshConversations,
  claimLaunchFocus,
}: {
  tabs: WorkspaceTab[];
  selected: boolean;
  active: string;
  conversations: ReturnType<typeof useWorktreeConversations>["conversations"];
  refreshConversations: () => Promise<void>;
  claimLaunchFocus: (id: string) => boolean;
}) {
  return tabs.map((tab) => (
    <TabsContent
      key={tab.id}
      value={tab.id}
      className="relative flex min-h-0 flex-1 flex-col overflow-hidden"
    >
      {selected && active === tab.id ? (
        tab.kind === "conversation" ? (
          <OpenCodeConversationPane
            conversation={conversations.find(({ id }) => id === tab.id)!}
            refresh={refreshConversations}
          />
        ) : (
          <Suspense
            fallback={<div className="p-4 text-sm text-muted-foreground">Loading terminal…</div>}
          >
            <TerminalPane sessionId={tab.id} claimLaunchFocus={claimLaunchFocus} />
          </Suspense>
        )
      ) : null}
    </TabsContent>
  ));
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
            loadFile={diffState.loadFile}
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
