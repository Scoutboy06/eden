import type { Issue, IssueGroup, IssueType, Priority } from "@/components/issue/issue";
import { priorityRank } from "@/components/issue/issue";

const searchableIssueFields = ["key", "title"] as const satisfies readonly (keyof Issue)[];
export const issueTypes = ["story", "bug", "task"] as const satisfies readonly IssueType[];
export const priorities = [
  "highest",
  "high",
  "medium",
  "low",
] as const satisfies readonly Priority[];

export type BoardFilters = {
  query: string;
  statuses: string[];
  types: IssueType[];
  priorities: Priority[];
  assignees: string[];
};

export type BoardSort = "manual" | "priority" | "updated";

export type BoardViewOptions = {
  filters: BoardFilters;
  sort: BoardSort;
};

export function parseBoardViewOptions(params: URLSearchParams): BoardViewOptions {
  const requestedSort = params.get("sort");

  return {
    filters: {
      query: params.get("q") ?? "",
      statuses: params.getAll("status"),
      types: params.getAll("type").filter(isIssueType),
      priorities: params.getAll("priority").filter(isPriority),
      assignees: params.getAll("assignee").filter(isAssigneeFilter),
    },
    sort: requestedSort === "priority" || requestedSort === "updated" ? requestedSort : "manual",
  };
}

export function assigneeFilterValue(name?: string) {
  return name === undefined ? "unassigned" : `person:${name}`;
}

export function filterGroups(groups: IssueGroup[], filters: BoardFilters) {
  const matchesIssue = createIssueMatcher(filters);
  const statusSet = new Set(filters.statuses);

  return groups
    .filter((group) => filters.statuses.length === 0 || statusSet.has(group.id))
    .map((group) => ({
      ...group,
      items: group.items.filter(matchesIssue),
    }));
}

export function sortGroups(groups: IssueGroup[], sort: BoardSort) {
  if (sort === "manual") return groups;

  return groups.map((group) => ({
    ...group,
    items: group.items
      .map((issue, index) => ({ issue, index }))
      .toSorted((a, b) => compareIssues(a.issue, b.issue, sort) || a.index - b.index)
      .map(({ issue }) => issue),
  }));
}

export function reconcileVisibleGroups(
  original: IssueGroup[],
  visible: IssueGroup[],
  options: BoardViewOptions,
) {
  const { filters, sort } = options;
  const matchesIssue = createIssueMatcher(filters);
  const visibleIds = new Set(
    original.flatMap((group) =>
      isSelectedStatus(group.id, filters.statuses)
        ? group.items.filter(matchesIssue).map((issue) => issue.id)
        : [],
    ),
  );

  if (sort !== "manual") return reconcileAutomaticMoves(original, visible, visibleIds);

  return reconcileManualOrder(original, visible, visibleIds, filters.statuses);
}

function createIssueMatcher(filters: BoardFilters) {
  const normalizedQuery = filters.query.trim().toLowerCase();
  const types = new Set(filters.types);
  const priorities = new Set(filters.priorities);
  const assignees = new Set(filters.assignees);

  return (issue: Issue) =>
    (!normalizedQuery ||
      searchableIssueFields.some((field) =>
        String(issue[field]).toLowerCase().includes(normalizedQuery),
      )) &&
    (types.size === 0 || types.has(issue.type)) &&
    (priorities.size === 0 || priorities.has(issue.priority)) &&
    (assignees.size === 0 || assignees.has(assigneeFilterValue(issue.assignee?.name)));
}

function reconcileManualOrder(
  original: IssueGroup[],
  visible: IssueGroup[],
  visibleIds: Set<string>,
  selectedStatuses: string[],
) {
  return original.map((group) => {
    if (!isSelectedStatus(group.id, selectedStatuses)) return group;

    const nextVisible = visible.find((candidate) => candidate.id === group.id)?.items ?? [];
    const items: Issue[] = [];
    let visibleIndex = 0;

    for (const issue of group.items) {
      if (!visibleIds.has(issue.id)) {
        items.push(issue);
      } else {
        const replacement = nextVisible[visibleIndex++];
        if (replacement) items.push(replacement);
      }
    }

    while (visibleIndex < nextVisible.length) items.push(nextVisible[visibleIndex++]!);

    return { ...group, items };
  });
}

function reconcileAutomaticMoves(
  original: IssueGroup[],
  visible: IssueGroup[],
  visibleIds: Set<string>,
) {
  const originalGroupByIssue = new Map(
    original.flatMap((group) => group.items.map((issue) => [issue.id, group.id])),
  );
  const issueById = new Map(
    original.flatMap((group) => group.items.map((issue) => [issue.id, issue])),
  );
  const movesByDestination = new Map<string, Issue[]>();
  const movedIds = new Set<string>();

  for (const group of visible) {
    for (const issue of group.items) {
      if (!visibleIds.has(issue.id) || originalGroupByIssue.get(issue.id) === group.id) continue;

      movedIds.add(issue.id);
      const destinationItems = movesByDestination.get(group.id) ?? [];
      destinationItems.push(issueById.get(issue.id) ?? issue);
      movesByDestination.set(group.id, destinationItems);
    }
  }

  return original.map((group) => ({
    ...group,
    items: [
      ...group.items.filter((issue) => !movedIds.has(issue.id)),
      ...(movesByDestination.get(group.id) ?? []),
    ],
  }));
}

function compareIssues(a: Issue, b: Issue, sort: Exclude<BoardSort, "manual">) {
  if (sort === "priority") return priorityRank[b.priority] - priorityRank[a.priority];

  const aUpdated = parseUpdatedAt(a.updatedAt);
  const bUpdated = parseUpdatedAt(b.updatedAt);
  if (aUpdated === undefined && bUpdated === undefined) return 0;
  if (aUpdated === undefined) return 1;
  if (bUpdated === undefined) return -1;
  return bUpdated - aUpdated;
}

function parseUpdatedAt(updatedAt?: string) {
  if (!updatedAt) return undefined;
  const timestamp = Date.parse(updatedAt);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function isSelectedStatus(status: string, statuses: string[]) {
  return statuses.length === 0 || statuses.includes(status);
}

function isIssueType(value: string): value is IssueType {
  return issueTypes.some((type) => type === value);
}

function isPriority(value: string): value is Priority {
  return priorities.some((priority) => priority === value);
}

function isAssigneeFilter(value: string) {
  return value === "unassigned" || value.startsWith("person:");
}
