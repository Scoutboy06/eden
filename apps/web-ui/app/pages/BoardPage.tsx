import { KanbanIcon, LeftToRightListBulletIcon, TableIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useSearchParams } from "react-router-dom";

import { IssueTable } from "@/components/issue-table/issue-table";
import { IssueList } from "@/components/issue-list/issue-list";
import { KanbanBoard } from "@/components/kanban/kanban-board";
import { useBeadsTasks } from "@/pages/use-beads-tasks";
import { TaskDetails } from "@/components/issue/task-detail-panel";
import { CreateTaskPrototypes } from "@/components/issue/create-task-prototypes";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { FiltersToolbar, SortToolbar, getIssueTypes } from "@/pages/board-filters-toolbar";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  type BoardFilters,
  filterGroups,
  parseBoardViewOptions,
  sortGroups,
} from "@/pages/board-filters";

const views = [
  { value: "board", label: "Board", icon: KanbanIcon },
  { value: "list", label: "List", icon: LeftToRightListBulletIcon },
  { value: "table", label: "Table", icon: TableIcon },
] as const;

type View = (typeof views)[number]["value"];

function isView(value: string | null): value is View {
  return views.some((view) => view.value === value);
}

export function BoardPage() {
  const { project, groups, loading, error, refresh } = useBeadsTasks();
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = searchParams.get("view");
  const view: View = isView(requested) ? requested : "board";
  const options = parseBoardViewOptions(searchParams, getIssueTypes(groups));
  const { filters, sort } = options;
  const filteredGroups = sortGroups(filterGroups(groups, filters), sort);
  const hasResults = filteredGroups.some((group) => group.items.length > 0);
  const taskCount = groups.reduce((count, group) => count + group.items.length, 0);

  function updateParams(update: (params: URLSearchParams) => void, replace = false) {
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        update(next);
        return next;
      },
      { replace },
    );
  }

  function updateQuery(value: string) {
    updateParams((params) => {
      if (value) params.set("q", value);
      else params.delete("q");
    }, true);
  }

  function updateMultiFilter(key: "status" | "type" | "priority" | "assignee", selected: string[]) {
    updateParams((params) => {
      params.delete(key);
      for (const value of selected) params.append(key, value);
    });
  }

  function updateSort(value: string | null) {
    updateParams((params) => {
      if (!value || value === "manual") params.delete("sort");
      else params.set("sort", value);
    });
  }

  function clearFilters() {
    updateParams((params) => {
      params.delete("q");
      params.delete("status");
      params.delete("type");
      params.delete("priority");
      params.delete("assignee");
    });
  }

  return (
    <TaskDetails key={project} project={project} groups={groups} onSaved={refresh}>
      <Tabs
        value={view}
        onValueChange={(next) =>
          updateParams((params) => {
            if (next === "board") params.delete("view");
            else params.set("view", String(next));
          })
        }
        className="flex min-h-0 flex-1 flex-col gap-0"
      >
        <header className="flex flex-wrap items-center gap-2 pb-3">
          <ViewSwitcher />
          <FiltersToolbar
            groups={groups}
            filters={filters}
            onQueryChange={updateQuery}
            onMultiFilterChange={updateMultiFilter}
          />
          <SortToolbar sort={sort} onSortChange={updateSort} />
          <CreateTaskPrototypes key={project} groups={groups} />
        </header>
        <Separator />
        <p className="py-3 text-xs text-muted-foreground">Beads · {taskCount} tasks</p>
        {loading && (
          <p role="status" className="py-4 text-sm text-muted-foreground">
            Loading Beads tasks…
          </p>
        )}
        {error && (
          <p role="alert" className="py-4 text-sm text-destructive">
            {error}
          </p>
        )}
        {!loading && !error && groups.length === 0 && (
          <p role="status" className="py-4 text-sm text-muted-foreground">
            No Beads tasks in this checkout.
          </p>
        )}
        {groups.length > 0 && (
          <>
            <TabsContent value="board" className="flex min-h-0 pt-4">
              <div className="flex min-h-0 w-full flex-col gap-3">
                {!hasResults && hasActiveFilters(filters) && <NoResults onClear={clearFilters} />}
                <KanbanBoard columns={filteredGroups} readOnly />
              </div>
            </TabsContent>
            <TabsContent value="list" className="pt-4">
              {hasResults ? (
                <IssueList groups={filteredGroups} />
              ) : (
                <NoResults onClear={clearFilters} />
              )}
            </TabsContent>
            <TabsContent value="table" className="pt-4">
              {hasResults ? (
                <IssueTable groups={filteredGroups} />
              ) : (
                <NoResults onClear={clearFilters} />
              )}
            </TabsContent>
          </>
        )}
      </Tabs>
    </TaskDetails>
  );
}

function ViewSwitcher() {
  return (
    <TabsList aria-label="View">
      {views.map(({ value, label, icon }) => (
        <TabsTrigger key={value} value={value}>
          <HugeiconsIcon icon={icon} strokeWidth={2} />
          {label}
        </TabsTrigger>
      ))}
    </TabsList>
  );
}

function hasActiveFilters(filters: BoardFilters) {
  return (
    filters.query.trim().length > 0 ||
    filters.statuses.length > 0 ||
    filters.types.length > 0 ||
    filters.priorities.length > 0 ||
    filters.assignees.length > 0
  );
}

function NoResults({ onClear }: { onClear: () => void }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border px-4 py-10 text-center">
      <p className="text-sm text-muted-foreground">No issues match your filters.</p>
      <Button variant="outline" size="sm" onClick={onClear}>
        Clear filters
      </Button>
    </div>
  );
}
