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
  for (let index = 0; index < 51; index++) {
    await cacheTaskDetail("eden", { ...task, id: `eden-${index}` });
  }
  resetTaskSnapshotsForTest();
  expect(await hydrateTaskDetail("eden", "eden-0")).toBeUndefined();
  expect(await hydrateTaskDetail("eden", "eden-50")).toBeDefined();
});
