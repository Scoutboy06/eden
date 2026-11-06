import { describe, expect, test } from "bun:test";

import type { Issue, IssueGroup } from "@/components/issue/issue";
import {
  assigneeFilterValue,
  filterGroups,
  parseBoardViewOptions,
  reconcileVisibleGroups,
  sortGroups,
  type BoardFilters,
} from "@/pages/board-filters";

const groups: IssueGroup[] = [
  {
    id: "backlog",
    title: "Backlog",
    items: [
      issue("1", "ALPHA", "Needle in the title", {
        type: "task",
        priority: "highest",
        assignee: { name: "Elias" },
        labels: ["secret"],
        updatedAt: "2026-11-05T10:00:00Z",
      }),
      issue("hidden", "BETA-8", "Hidden issue", { type: "bug", priority: "low" }),
      issue("3", "GAMMA-2", "Another issue", {
        type: "story",
        priority: "medium",
        assignee: { name: "Unassigned" },
        updatedAt: "not-a-date",
      }),
    ],
  },
  {
    id: "done",
    title: "Done",
    items: [
      issue("hidden-done", "BETA-9", "Other hidden issue", { type: "bug", priority: "low" }),
      issue("2", "DELTA-4", "Other title", { type: "bug", priority: "low" }),
    ],
  },
];

describe("board filters and ordering", () => {
  test("searches key and title independently and ignores non-searchable fields", () => {
    expect(issueIds(filterGroups(groups, filters({ query: "  alpha  " })))).toEqual(["1"]);
    expect(issueIds(filterGroups(groups, filters({ query: "needle" })))).toEqual(["1"]);
    expect(issueIds(filterGroups(groups, filters({ query: "alpha needle" })))).toEqual([]);
    expect(issueIds(filterGroups(groups, filters({ query: "secret" })))).toEqual([]);
    expect(issueIds(filterGroups(groups, filters({ query: "  " })))).toHaveLength(5);
  });

  test("parses query parameters and defaults missing or invalid options", () => {
    expect(parseBoardViewOptions(new URLSearchParams())).toEqual({
      filters: filters(),
      sort: "manual",
    });
    expect(
      parseBoardViewOptions(
        new URLSearchParams(
          "q=alpha&status=backlog&status=done&type=bug&type=invalid&priority=high&assignee=unassigned&assignee=person%3AElias&sort=updated&other=keep",
        ),
      ),
    ).toEqual({
      filters: filters({
        query: "alpha",
        statuses: ["backlog", "done"],
        types: ["bug"],
        priorities: ["high"],
        assignees: ["unassigned", "person:Elias"],
      }),
      sort: "updated",
    });
    expect(parseBoardViewOptions(new URLSearchParams("sort=invalid")).sort).toBe("manual");
  });

  test("combines categories with AND and selected values within each category with OR", () => {
    const filtered = filterGroups(
      groups,
      filters({
        statuses: ["backlog", "done"],
        types: ["task", "bug"],
        priorities: ["highest", "low"],
        assignees: [assigneeFilterValue("Elias"), assigneeFilterValue()],
      }),
    );

    expect(issueIds(filtered)).toEqual(["1", "hidden", "hidden-done", "2"]);
    expect(
      issueIds(filterGroups(groups, filters({ assignees: [assigneeFilterValue("Unassigned")] }))),
    ).toEqual(["3"]);
    expect(issueIds(filterGroups(groups, filters({ assignees: [assigneeFilterValue()] })))).toEqual(
      ["hidden", "hidden-done", "2"],
    );
    expect(issueIds(filterGroups(groups, filters({ statuses: ["backlog"] })))).toEqual([
      "1",
      "hidden",
      "3",
    ]);
    expect(issueIds(filterGroups(groups, filters({ priorities: ["highest"] })))).toEqual(["1"]);
  });

  test("sorts within groups, preserving manual ties and placing invalid dates last", () => {
    const prioritySorted = sortGroups(groups, "priority");
    expect(issueIds(prioritySorted.slice(0, 1))).toEqual(["1", "3", "hidden"]);
    expect(issueIds(prioritySorted.slice(1))).toEqual(["hidden-done", "2"]);

    const datedGroups: IssueGroup[] = [
      {
        id: "dates",
        title: "Dates",
        items: [
          issue("older", "O", "Older", { updatedAt: "2026-11-03T12:00:00Z" }),
          issue("tie-z", "Z", "Tie", { updatedAt: "2026-11-04T12:00:00Z" }),
          issue("newest", "N", "Newest", { updatedAt: "2026-11-05T12:00:00Z" }),
          issue("tie-offset", "T", "Tie", { updatedAt: "2026-11-04T13:00:00+01:00" }),
          issue("invalid", "I", "Invalid", { updatedAt: "invalid" }),
          issue("missing", "M", "Missing"),
        ],
      },
    ];
    const canonicalIds = issueIds(datedGroups);

    expect(issueIds(sortGroups(datedGroups, "updated"))).toEqual([
      "newest",
      "tie-z",
      "tie-offset",
      "older",
      "invalid",
      "missing",
    ]);
    expect(issueIds(datedGroups)).toEqual(canonicalIds);
    expect(issueIds(sortGroups(datedGroups, "manual"))).toEqual(canonicalIds);
  });

  test("keeps assignee names distinct from the Unassigned sentinel", () => {
    expect(assigneeFilterValue()).toBe("unassigned");
    expect(assigneeFilterValue("unassigned")).toBe("person:unassigned");
    expect(assigneeFilterValue("Unassigned")).toBe("person:Unassigned");
  });

  test("reconciles filtered manual drag order without deleting hidden issues", () => {
    const options = { filters: filters({ query: "alpha" }), sort: "manual" as const };
    const visible = filterGroups(groups, options.filters);
    const reordered: IssueGroup[] = [
      { ...visible[0]!, items: [] },
      { ...visible[1]!, items: [visible[0]!.items[0]!] },
    ];

    const result = reconcileVisibleGroups(groups, reordered, options);
    const resultIds = issueIds(result);

    expect(result.map((group) => group.items.map((item) => item.id))).toEqual([
      ["hidden", "3"],
      ["hidden-done", "2", "1"],
    ]);
    expect(resultIds).toHaveLength(new Set(resultIds).size);
    expect(resultIds.toSorted()).toEqual(issueIds(groups).toSorted());
  });

  test("keeps unselected status data untouched during selected-column moves", () => {
    const source: IssueGroup[] = [
      {
        id: "backlog",
        title: "Backlog",
        items: [issue("a", "A", "match A"), issue("backlog-hidden", "H1", "other backlog issue")],
      },
      {
        id: "done",
        title: "Done",
        items: [issue("b", "B", "match B"), issue("done-hidden", "H2", "other completed issue")],
      },
      {
        id: "unselected",
        title: "Unselected",
        items: [issue("c", "C", "match C"), issue("unselected-hidden", "H3", "other status issue")],
      },
    ];
    const options = {
      filters: filters({ query: "match", statuses: ["backlog", "done"] }),
      sort: "manual" as const,
    };
    const visible = filterGroups(source, options.filters);
    const moved: IssueGroup[] = [
      { ...visible[0]!, items: [visible[1]!.items[0]!] },
      { ...visible[1]!, items: [visible[0]!.items[0]!] },
    ];

    const result = reconcileVisibleGroups(source, moved, options);
    const ids = issueIds(result);

    expect(result[2]).toEqual(source[2]);
    expect(ids).toHaveLength(new Set(ids).size);
    expect(ids.toSorted()).toEqual(issueIds(source).toSorted());
    expect(result.map((group) => group.items.map((item) => item.id))).toEqual([
      ["b", "backlog-hidden"],
      ["a", "done-hidden"],
      ["c", "unselected-hidden"],
    ]);
  });

  test("keeps hidden slots stable while reordering visible issues", () => {
    const source: IssueGroup[] = [
      {
        id: "backlog",
        title: "Backlog",
        items: [
          issue("a", "A", "shown A"),
          issue("hidden-1", "H1", "hidden one"),
          issue("b", "B", "shown B"),
          issue("hidden-2", "H2", "hidden two"),
          issue("c", "C", "shown C"),
        ],
      },
    ];
    const options = { filters: filters({ query: "shown" }), sort: "manual" as const };
    const visible = filterGroups(source, options.filters);
    const reordered = [
      {
        ...visible[0]!,
        items: [visible[0]!.items[2]!, visible[0]!.items[0]!, visible[0]!.items[1]!],
      },
    ];

    const result = reconcileVisibleGroups(source, reordered, options);

    expect(issueIds(result)).toEqual(["c", "hidden-1", "a", "hidden-2", "b"]);
  });

  test("preserves canonical manual order after a move from an automatic sort projection", () => {
    const source: IssueGroup[] = [
      {
        id: "backlog",
        title: "Backlog",
        items: [
          issue("move", "M", "shown", { priority: "medium" }),
          issue("hidden", "H", "hidden"),
        ],
      },
      {
        id: "todo",
        title: "To do",
        items: [
          issue("low", "L", "shown low", { priority: "low" }),
          issue("hidden-destination", "H", "other destination issue", { priority: "medium" }),
          issue("high", "H", "shown high", { priority: "highest" }),
        ],
      },
    ];
    const options = { filters: filters({ query: "shown" }), sort: "priority" as const };
    const projection = sortGroups(filterGroups(source, options.filters), options.sort);
    expect(reconcileVisibleGroups(source, projection, options)).toEqual(source);
    const moved = [
      { ...projection[0]!, items: [] },
      {
        ...projection[1]!,
        items: [projection[1]!.items[0]!, projection[0]!.items[0]!, projection[1]!.items[1]!],
      },
    ];

    const result = reconcileVisibleGroups(source, moved, options);
    const resultIds = issueIds(result);

    expect(result.map((group) => group.items.map((item) => item.id))).toEqual([
      ["hidden"],
      ["low", "hidden-destination", "high", "move"],
    ]);
    expect(resultIds).toHaveLength(new Set(resultIds).size);
    expect(resultIds.toSorted()).toEqual(issueIds(source).toSorted());
  });

  test("preserves data on an unchanged filtered roundtrip", () => {
    const options = { filters: filters({ query: "alpha" }), sort: "manual" as const };
    expect(reconcileVisibleGroups(groups, filterGroups(groups, options.filters), options)).toEqual(
      groups,
    );
  });
});

function filters(overrides: Partial<BoardFilters> = {}): BoardFilters {
  return {
    query: "",
    statuses: [],
    types: [],
    priorities: [],
    assignees: [],
    ...overrides,
  };
}

function issue(id: string, key: string, title: string, values: Partial<Issue> = {}): Issue {
  return {
    id,
    key,
    title,
    type: "task",
    priority: "low",
    ...values,
  };
}

function issueIds(groups: IssueGroup[]) {
  return groups.flatMap((group) => group.items.map((item) => item.id));
}
