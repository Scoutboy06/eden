import { Search01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useRef, type RefObject } from "react";

import { issueTypeLabel, type IssueGroup } from "@/components/issue/issue";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
} from "@/components/ui/select";
import {
  assigneeFilterValue,
  type BoardFilters,
  type BoardSort,
  priorities,
} from "@/pages/board-filters";

export function FiltersToolbar({
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
  const issueTypes = getIssueTypes(groups);
  const availablePriorities = priorities.filter((priority) =>
    groups.some((group) => group.items.some((issue) => issue.priority === priority)),
  );
  const statusCount = filters.statuses.length;
  const typeCount = filters.types.length;
  const priorityCount = filters.priorities.length;
  const assigneeCount = filters.assignees.length;
  const statusLabel = statusCount > 0 ? `Status · ${statusCount}` : "Status";
  const typeLabel = typeCount > 0 ? `Type · ${typeCount}` : "Type";
  const priorityLabel = priorityCount > 0 ? `Priority · ${priorityCount}` : "Priority";
  const assigneeLabel = assigneeCount > 0 ? `Assignee · ${assigneeCount}` : "Assignee";
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
          {statusLabel}
        </SelectTrigger>
        <SelectContent
          align="start"
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
          {typeLabel}
        </SelectTrigger>
        <SelectContent
          align="start"
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
          {priorityLabel}
        </SelectTrigger>
        <SelectContent
          align="start"
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
            {availablePriorities.map((priority) => (
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
          {assigneeLabel}
        </SelectTrigger>
        <SelectContent
          align="start"
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

function getAssigneeOptions(groups: IssueGroup[]) {
  const names = groups.flatMap((group) =>
    group.items
      .map((issue) => issue.assignee?.name)
      .filter((name): name is string => name !== undefined),
  );
  const uniqueNames = [...new Set(names)].toSorted((a, b) => a.localeCompare(b));
  return [
    { value: assigneeFilterValue(), label: "Unassigned" },
    ...uniqueNames.map((name) => ({ value: assigneeFilterValue(name), label: name })),
  ];
}

export function getIssueTypes(groups: IssueGroup[]) {
  const tasks = groups.flatMap((group) => group.items);
  return [...new Set(tasks.map((task) => task.type))].sort();
}

export function SortToolbar({
  sort,
  onSortChange,
}: {
  sort: BoardSort;
  onSortChange: (value: string | null) => void;
}) {
  return (
    <Select<string> value={sort} onValueChange={onSortChange}>
      <SelectTrigger aria-label="Sort issues">{sortLabel(sort)}</SelectTrigger>
      <SelectContent align="end" className="w-48">
        <SelectGroup>
          <SelectLabel>Sort by</SelectLabel>
          <SelectItem value="manual">Provider order</SelectItem>
          <SelectItem value="priority">Priority first</SelectItem>
          <SelectItem value="updated">Recently updated</SelectItem>
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

function sortLabel(sort: BoardSort) {
  if (sort === "priority") return "Priority first";
  if (sort === "updated") return "Recently updated";
  return "Provider order";
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
