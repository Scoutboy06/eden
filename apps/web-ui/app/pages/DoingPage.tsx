import { useState } from "react";
import { useOutletContext } from "react-router-dom";

import { CIStatus } from "@/components/ci-status";
import {
  agentHarnesses,
  tasks,
  type AgentHarness,
  type Task,
} from "@/components/tasks-sidebar-data";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { closeSessionTab, createWorkspaceTabs, type SessionTab } from "@/pages/doing-tabs";
import { formatPullRequestReference } from "@/pages/prs-data";

export function DoingPage() {
  const { selectedTaskKey } = useOutletContext<{ selectedTaskKey: string }>();

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {tasks.map((task) => (
        <div
          key={task.key}
          hidden={task.key !== selectedTaskKey}
          className={task.key === selectedTaskKey ? "flex min-h-0 flex-1 flex-col" : "hidden"}
        >
          <Workspace task={task} />
        </div>
      ))}
    </div>
  );
}

function Workspace({ task }: { task: Task }) {
  const [state, setState] = useState(() => createWorkspaceTabs(task));

  function addSession(kind: SessionTab["kind"], harness?: AgentHarness) {
    const tab: SessionTab = {
      id: crypto.randomUUID(),
      kind,
      title: kind === "terminal" ? "Terminal" : agentHarnesses[harness!].title,
      harness,
    };

    setState((current) => ({ active: tab.id, sessions: [...current.sessions, tab] }));
  }

  return (
    <section aria-label={`${task.title} workspace`} className="flex min-h-0 flex-1 flex-col">
      <header className="flex min-h-16 shrink-0 items-center justify-between gap-4 border-b border-border px-6 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="font-mono">{task.key}</span>
            <span aria-hidden="true">/</span>
            <span className="truncate">{task.worktree?.name ?? "No worktree"}</span>
          </div>
          <h1 className="mt-1 truncate text-sm font-semibold">{task.title}</h1>
        </div>
        <span className="shrink-0 rounded border border-border px-2 py-1 text-[10px] text-muted-foreground">
          Demo workspace
        </span>
      </header>
      <Tabs
        value={state.active}
        onValueChange={(value) => setState((current) => ({ ...current, active: String(value) }))}
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
              {state.sessions.map((tab) => (
                <div key={tab.id} className="relative flex shrink-0 items-center">
                  <TabsTrigger
                    value={tab.id}
                    className="h-11 flex-none rounded-none pr-8 pl-4 after:bottom-0!"
                  >
                    <span aria-hidden="true" className="font-mono text-xs text-muted-foreground">
                      {tab.kind === "terminal" ? ">_" : "◉"}
                    </span>
                    <span className="max-w-40 truncate">{tab.title}</span>
                  </TabsTrigger>
                  <button
                    type="button"
                    aria-label={`Close ${tab.title}`}
                    onClick={() => setState((current) => closeSessionTab(current, tab.id))}
                    className="absolute right-1.5 rounded px-1 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
                  >
                    ×
                  </button>
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
            <DropdownMenuContent>
              {(Object.keys(agentHarnesses) as AgentHarness[]).map((harness) => (
                <DropdownMenuItem key={harness} onClick={() => addSession("agent", harness)}>
                  New {agentHarnesses[harness].title} agent
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => addSession("terminal")}>
                New terminal
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <TabsContent value="reviews" className="overflow-y-auto p-6">
          <Reviews task={task} />
        </TabsContent>
        <TabsContent value="diff" className="overflow-y-auto p-6">
          <Diff task={task} />
        </TabsContent>
        {state.sessions.map((tab) => (
          <TabsContent
            key={tab.id}
            value={tab.id}
            keepMounted
            className="min-h-0 overflow-y-auto data-hidden:hidden"
          >
            <Session tab={tab} task={task} />
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

function Diff({ task }: { task: Task }) {
  if (!task.worktree)
    return (
      <EmptyPanel
        title="No worktree attached"
        description="A worktree is needed to view changes for this task."
      />
    );

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <div>
        <h2 className="text-sm font-semibold">Working tree changes</h2>
        <p className="mt-1 font-mono text-xs text-muted-foreground">
          {task.worktree.branch ?? task.worktree.name}
        </p>
      </div>
      {task.key === "CODE-20388" ? (
        <div className="overflow-hidden rounded-lg border border-border">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-muted/30 px-4 py-3 text-xs">
            <span className="font-mono">src/page-metadata.ts</span>
            <span className="text-muted-foreground">Illustrative diff · not live Git data</span>
          </div>
          <pre className="overflow-x-auto py-4 font-mono text-xs leading-7">
            <code>
              <span className="block px-4 text-muted-foreground">@@ -12,3 +12,4 @@</span>
              <span className="block bg-red-500/10 px-4 text-red-700 dark:text-red-300">
                - const title = page.title;
              </span>
              <span className="block bg-emerald-500/10 px-4 text-emerald-700 dark:text-emerald-300">
                + const title = translatePageTitle(page, locale);
              </span>
              <span className="block bg-emerald-500/10 px-4 text-emerald-700 dark:text-emerald-300">
                + const socialTitle = title;
              </span>
              <span className="block px-4"> return createMeta(title, socialTitle);</span>
            </code>
          </pre>
        </div>
      ) : (
        <EmptyPanel
          title="No demo changes"
          description="Live Git diffs are not connected yet. Select Page title translations to explore an illustrative diff."
        />
      )}
    </div>
  );
}

function Session({ tab, task }: { tab: SessionTab; task: Task }) {
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState<string[]>([]);
  const terminal = tab.kind === "terminal";

  return (
    <div
      className={`flex min-h-full flex-col ${terminal ? "bg-muted/15 font-mono" : "mx-auto max-w-3xl"}`}
    >
      <div className="flex items-center justify-between gap-3 border-b border-border px-6 py-3 text-xs">
        <span className="font-medium">
          {terminal ? "Terminal" : agentHarnesses[tab.harness!].title}
        </span>
        <span className="text-muted-foreground">Preview · not connected</span>
      </div>
      <div className="flex-1 space-y-4 p-6 text-sm">
        <p className="text-xs leading-relaxed text-muted-foreground">
          {terminal
            ? `Terminal preview for ${task.worktree?.name ?? task.key}. Commands entered here are not executed.`
            : `Agent session for ${task.title}. Messages stay in this local preview; no agent is running.`}
        </p>
        {messages.map((message, index) => (
          <div
            key={index}
            className={
              terminal
                ? "whitespace-pre-wrap break-words"
                : "ml-auto w-fit max-w-[90%] whitespace-pre-wrap break-words rounded-lg bg-muted px-4 py-3"
            }
          >
            {terminal ? "$ " : ""}
            {message}
          </div>
        ))}
      </div>
      <form
        className="m-6 mt-0 flex items-end gap-3 rounded-lg border border-border bg-background p-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (!draft.trim()) return;
          setMessages((current) => [...current, draft]);
          setDraft("");
        }}
      >
        <label className="flex min-w-0 flex-1 items-center gap-2">
          {terminal ? (
            <span aria-hidden="true" className="text-muted-foreground">
              $
            </span>
          ) : null}
          <input
            aria-label={terminal ? "Preview command" : "Message agent"}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={terminal ? "Enter a preview command…" : "Message agent…"}
            className="w-full bg-transparent text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          />
        </label>
        <Button type="submit" size="sm" variant="secondary" disabled={!draft.trim()}>
          {terminal ? "Enter" : "Send"}
        </Button>
      </form>
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
