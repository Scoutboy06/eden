import { expect, test } from "bun:test";
import { indexedDB } from "fake-indexeddb";

import type { BeadsTaskDetail } from "../../../../src/external/beads/task-detail";
import {
  cacheTaskDetail,
  cacheTaskGroups,
  cachedTaskDetail,
  cachedTaskGroups,
  forgetTaskGroups,
  hydrateTaskDetail,
  hydrateTaskGroups,
  projectTaskPatch,
  resetTaskSnapshotsForTest,
  taskGroupsSnapshot,
} from "./task-cache";

const board = [{ id: "open", title: "Open", items: [] }];
const task: BeadsTaskDetail = {
  id: "eden-1",
  title: "Persisted task",
  description: "",
  status: "open",
  priority: 2,
  issue_type: "task",
  labels: [],
  created_at: "2026-11-26",
  updated_at: "2026-11-26",
};

test("persists isolated board snapshots and hydrates them before refresh", async () => {
  globalThis.indexedDB = indexedDB;
  resetTaskSnapshotsForTest();

  await cacheTaskGroups("eden", board);
  await cacheTaskGroups("another", []);
  resetTaskSnapshotsForTest();

  expect(cachedTaskGroups("eden")).toBeUndefined();
  expect((await hydrateTaskGroups("eden"))?.value).toEqual(board);
  expect((await hydrateTaskGroups("another"))?.value).toEqual([]);
  expect(await hydrateTaskGroups("missing")).toBeUndefined();

  forgetTaskGroups("another");
  expect(cachedTaskGroups("another")).toBeUndefined();
  expect(taskGroupsSnapshot("eden")?.value).toEqual(board);
});

test("persists recently read task details by project and keeps the cache bounded", async () => {
  globalThis.indexedDB = indexedDB;
  resetTaskSnapshotsForTest();

  await cacheTaskDetail("eden", task);
  await cacheTaskDetail("another", { ...task, title: "Other project task" });
  resetTaskSnapshotsForTest();

  expect((await hydrateTaskDetail("eden", task.id))?.value).toEqual(task);
  expect((await hydrateTaskDetail("another", task.id))?.value.title).toBe("Other project task");
  expect(await hydrateTaskDetail("missing", task.id)).toBeUndefined();
  expect(cachedTaskDetail("eden", task.id)?.value).toEqual(task);

  resetTaskSnapshotsForTest();
  const originalNow = Date.now;
  Date.now = () => 1_000;
  try {
    for (let index = 0; index < 51; index++) {
      await cacheTaskDetail("eden", { ...task, id: `eden-${index}` });
    }
  } finally {
    Date.now = originalNow;
  }
  resetTaskSnapshotsForTest();
  expect(await hydrateTaskDetail("eden", "eden-0")).toBeUndefined();
  expect(await hydrateTaskDetail("eden", "eden-50")).toBeDefined();
});

test("projects connected task edits into Board groups without mutating cached snapshots", () => {
  const groups = [
    {
      id: "open",
      title: "Open",
      color: "bg-blue-500",
      source: { label: "Open", detail: "Open tasks" },
      items: [
        {
          id: task.id,
          key: task.id,
          title: task.title,
          type: task.issue_type,
          priority: "P2" as const,
          labels: [],
        },
      ],
    },
  ];

  const updated = projectTaskPatch(groups, task.id, {
    title: "Optimistic title",
    status: "in_progress",
    priority: 1,
    labels: ["urgent"],
  });

  expect(groups[0]?.items[0]?.title).toBe(task.title);
  expect(updated).toHaveLength(1);
  expect(updated[0]?.id).toBe("in_progress");
  expect(updated[0]?.items[0]).toMatchObject({
    title: "Optimistic title",
    priority: "P1",
    labels: ["urgent"],
    done: false,
  });
});
