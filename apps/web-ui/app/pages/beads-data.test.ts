import { expect, test } from "bun:test";

import type { BeadsTask } from "../../../../src/external/beads/tasks";
import { beadsTaskGroups } from "./beads-data";
import { filterGroups, parseBoardViewOptions, sortGroups } from "./board-filters";

const task: BeadsTask = {
  id: "eden-8.1",
  title: "Native task",
  status: "open",
  issue_type: "decision",
  priority: 4,
};

test("keeps native statuses, custom types, P4 priority and optional summary fields", () => {
  const groups = beadsTaskGroups([
    {
      ...task,
      status: "waiting_for_review",
      assignee: "Elias",
      labels: ["design"],
      comment_count: 2,
    },
    { ...task, id: "closed", status: "closed", priority: 0 },
  ]);

  expect(groups.map((group) => group.id)).toEqual(["closed", "waiting_for_review"]);
  expect(groups[1]).toMatchObject({
    title: "waiting_for_review",
    items: [
      {
        id: task.id,
        key: task.id,
        type: "decision",
        priority: "P4",
        assignee: { name: "Elias" },
        labels: ["design"],
        commentCount: 2,
        done: false,
      },
    ],
  });
  expect(groups[0]!.items[0]).toMatchObject({ priority: "P0", done: true });
  expect(groups[0]!.items[0]!.pullRequest).toBeUndefined();
});

test("filters provider types and priorities and sorts all five priority levels", () => {
  const groups = beadsTaskGroups([
    task,
    { ...task, id: "urgent", priority: 0 },
    { ...task, id: "normal", priority: 2 },
  ]);
  const { filters } = parseBoardViewOptions(new URLSearchParams("type=decision&priority=P4"), [
    "decision",
  ]);

  expect(filterGroups(groups, filters)[0]!.items.map((issue) => issue.id)).toEqual([task.id]);
  expect(sortGroups(groups, "priority")[0]!.items.map((issue) => issue.id)).toEqual([
    "urgent",
    "normal",
    task.id,
  ]);
});

test("represents an empty provider without fabricated columns", () => {
  expect(beadsTaskGroups([])).toEqual([]);
});
