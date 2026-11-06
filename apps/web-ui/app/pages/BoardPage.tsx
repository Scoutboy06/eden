import {
  Add01Icon,
  KanbanIcon,
  LeftToRightListBulletIcon,
  Search01Icon,
  TableIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useRef, useState, type RefObject } from "react";
import { useSearchParams } from "react-router-dom";

import { IssueTable } from "@/components/issue-table/issue-table";
import { IssueList } from "@/components/issue-list/issue-list";
import { KanbanBoard } from "@/components/kanban/kanban-board";
import { sampleGroups } from "@/pages/board-data";
import { issueTypeLabel } from "@/components/issue/issue";
import type { IssueGroup } from "@/components/issue/issue";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  assigneeFilterValue,
  type BoardFilters,
  type BoardSort,
  filterGroups,
  issueTypes,
  parseBoardViewOptions,
  priorities,
  reconcileVisibleGroups,
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
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = searchParams.get("view");
  const view: View = isView(requested) ? requested : "board";
  const options = parseBoardViewOptions(searchParams);
  const { filters, sort } = options;
  // Shared by every view, so a card moved on the board shows up in the list too.
  const [groups, setGroups] = useState(sampleGroups);
  const filteredGroups = sortGroups(filterGroups(groups, filters), sort);
  const hasResults = filteredGroups.some((group) => group.items.length > 0);

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
    <Tabs
      value={view}
      onValueChange={(next) =>
        updateParams((params) => {
          if (next === "board") params.delete("view");
          else params.set("view", String(next));
        })
      }
      className="flex flex-1 flex-col gap-0"
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
        <Button type="button" size="lg" className="px-3">
          <HugeiconsIcon icon={Add01Icon} aria-hidden="true" strokeWidth={2} className="size-4" />
          New task
        </Button>
      </header>
      <Separator />
      <TabsContent value="board" className="flex pt-4">
        <div className="flex w-full flex-col gap-3">
          {!hasResults && hasActiveFilters(filters) && <NoResults onClear={clearFilters} />}
          <KanbanBoard
            columns={filteredGroups}
            allowReorder={sort === "manual"}
            onColumnsChange={(next) =>
              setGroups((current) => reconcileVisibleGroups(current, next, options))
            }
          />
        </div>
      </TabsContent>
      <TabsContent value="list" className="pt-4">
        {hasResults ? <IssueList groups={filteredGroups} /> : <NoResults onClear={clearFilters} />}
      </TabsContent>
      <TabsContent value="table" className="pt-4">
        {hasResults ? <IssueTable groups={filteredGroups} /> : <NoResults onClear={clearFilters} />}
      </TabsContent>
    </Tabs>
  );
}

function FiltersToolbar({
  groups,
  filters,
  onQueryChange,
  onMultiFilterChange,
}: {
  groups: IssueGroup[];
  filters: BoardFilters;
  onQueryChange: (value: string) => void;
  onMultiFilterChange: (
    key: "status" | "type" | "priority" | "assignee",
    selected: string[],
  ) => void;
}) {
  const assigneeOptions = getAssigneeOptions(groups);
  const statusTriggerRef = useRef<HTMLButtonElement>(null);
  const typeTriggerRef = useRef<HTMLButtonElement>(null);
  const priorityTriggerRef = useRef<HTMLButtonElement>(null);
  const assigneeTriggerRef = useRef<HTMLButtonElement>(null);

  return (
    <>
      <div className="relative w-64">
        <label className="sr-only" htmlFor="issue-search">
          Search tasks by key or title
        </label>
        <HugeiconsIcon
          icon={Search01Icon}
          aria-hidden="true"
          strokeWidth={2}
          className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <input
          id="issue-search"
          type="search"
          value={filters.query}
          onChange={(event) => onQueryChange(event.currentTarget.value)}
          placeholder="Search tasks…"
          className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 pl-8 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
        />
      </div>
      <Select<string, true>
        multiple
        value={filters.statuses}
        onValueChange={(selected) => onMultiFilterChange("status", selected)}
      >
        <SelectTrigger ref={statusTriggerRef} aria-label="Filter by status">
          Status{filters.statuses.length > 0 ? ` · ${filters.statuses.length}` : ""}
        </SelectTrigger>
        <SelectContent
          align="start"
          alignItemWithTrigger={false}
          className="w-48"
          footer={
            filters.statuses.length > 0 && (
              <ClearSelectionFooter
                label="status"
                onClear={() => onMultiFilterChange("status", [])}
                returnFocusRef={statusTriggerRef}
              />
            )
          }
        >
          <SelectGroup>
            <SelectLabel>Status</SelectLabel>
            {groups.map((group) => (
              <SelectItem key={group.id} value={group.id}>
                {group.title}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      <Select<string, true>
        multiple
        value={filters.types}
        onValueChange={(selected) => onMultiFilterChange("type", selected)}
      >
        <SelectTrigger ref={typeTriggerRef} aria-label="Filter by task type">
          Type{filters.types.length > 0 ? ` · ${filters.types.length}` : ""}
        </SelectTrigger>
        <SelectContent
          align="start"
          alignItemWithTrigger={false}
          className="w-40"
          footer={
            filters.types.length > 0 && (
              <ClearSelectionFooter
                label="task type"
                onClear={() => onMultiFilterChange("type", [])}
                returnFocusRef={typeTriggerRef}
              />
            )
          }
        >
          <SelectGroup>
            <SelectLabel>Task type</SelectLabel>
            {issueTypes.map((type) => (
              <SelectItem key={type} value={type}>
                {issueTypeLabel(type)}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      <Select<string, true>
        multiple
        value={filters.priorities}
        onValueChange={(selected) => onMultiFilterChange("priority", selected)}
      >
        <SelectTrigger ref={priorityTriggerRef} aria-label="Filter by priority">
          Priority{filters.priorities.length > 0 ? ` · ${filters.priorities.length}` : ""}
        </SelectTrigger>
        <SelectContent
          align="start"
          alignItemWithTrigger={false}
          className="w-40"
          footer={
            filters.priorities.length > 0 && (
              <ClearSelectionFooter
                label="priority"
                onClear={() => onMultiFilterChange("priority", [])}
                returnFocusRef={priorityTriggerRef}
              />
            )
          }
        >
          <SelectGroup>
            <SelectLabel>Priority</SelectLabel>
            {priorities.map((priority) => (
              <SelectItem key={priority} value={priority}>
                {priority[0]!.toUpperCase() + priority.slice(1)}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      <Select<string, true>
        multiple
        value={filters.assignees}
        onValueChange={(selected) => onMultiFilterChange("assignee", selected)}
      >
        <SelectTrigger ref={assigneeTriggerRef} aria-label="Filter by assignee">
          Assignee{filters.assignees.length > 0 ? ` · ${filters.assignees.length}` : ""}
        </SelectTrigger>
        <SelectContent
          align="start"
          alignItemWithTrigger={false}
          className="w-48"
          footer={
            filters.assignees.length > 0 && (
              <ClearSelectionFooter
                label="assignee"
                onClear={() => onMultiFilterChange("assignee", [])}
                returnFocusRef={assigneeTriggerRef}
              />
            )
          }
        >
          <SelectGroup>
            <SelectLabel>Assignee</SelectLabel>
            {assigneeOptions.map(({ value, label }) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </>
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

function SortToolbar({
  sort,
  onSortChange,
}: {
  sort: BoardSort;
  onSortChange: (value: string | null) => void;
}) {
  return (
    <>
      <Select<string> value={sort} onValueChange={onSortChange}>
        <SelectTrigger aria-label="Sort issues">{sortLabel(sort)}</SelectTrigger>
        <SelectContent align="end" alignItemWithTrigger={false} className="w-48">
          <SelectGroup>
            <SelectLabel>Sort by</SelectLabel>
            <SelectItem value="manual">Manual order</SelectItem>
            <SelectItem value="priority">Priority first</SelectItem>
            <SelectItem value="updated">Recently updated</SelectItem>
          </SelectGroup>
        </SelectContent>
      </Select>
    </>
  );
}

function ClearSelectionFooter({
  label,
  onClear,
  returnFocusRef,
}: {
  label: string;
  onClear: () => void;
  returnFocusRef: RefObject<HTMLButtonElement | null>;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="w-full justify-start"
      aria-label={`Clear ${label} filter`}
      onClick={() => {
        onClear();
        returnFocusRef.current?.focus();
      }}
    >
      Clear selection
    </Button>
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

function getAssigneeOptions(groups: IssueGroup[]) {
  const names = groups.flatMap((group) =>
    group.items
      .map((issue) => issue.assignee?.name)
      .filter((name): name is string => name !== undefined),
  );

  return [
    { value: assigneeFilterValue(), label: "Unassigned" },
    ...[...new Set(names)]
      .toSorted((a, b) => a.localeCompare(b))
      .map((name) => ({ value: assigneeFilterValue(name), label: name })),
  ];
}

function sortLabel(sort: BoardSort) {
  if (sort === "priority") return "Priority first";
  if (sort === "updated") return "Recently updated";
  return "Manual order";
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
