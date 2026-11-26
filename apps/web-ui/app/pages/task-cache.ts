import type { BeadsTaskDetail, BeadsTaskPatch } from "../../../../src/external/beads/task-detail";
import type { IssueGroup } from "../components/issue/issue";

type Snapshot<T> = { value: T; savedAt: number };
type StoredSnapshot = {
  key: string;
  project: string;
  kind: "board" | "detail";
  taskId?: string;
  value: unknown;
  savedAt: number;
};

const databaseName = "eden-read-snapshots";
const storeName = "snapshots";
const maxBoardProjects = 20;
const maxTaskDetails = 50;
const boards = new Map<string, Snapshot<IssueGroup[]>>();
const details = new Map<string, Snapshot<BeadsTaskDetail>>();
let database: Promise<IDBDatabase> | undefined;
let lastSavedAt = 0;

export function cachedTaskGroups(project: string) {
  return boards.get(project)?.value;
}

export function taskGroupsSnapshot(project: string) {
  return boards.get(project);
}

export function cacheTaskGroups(project: string, groups: IssueGroup[]) {
  const snapshot = { value: groups, savedAt: nextSavedAt() };
  boards.delete(project);
  boards.set(project, snapshot);
  while (boards.size > maxBoardProjects) boards.delete(boards.keys().next().value!);
  return persist({ project, kind: "board", value: groups, savedAt: snapshot.savedAt });
}

export async function hydrateTaskGroups(project: string) {
  const snapshot = await readSnapshot<IssueGroup[]>(boardKey(project));
  if (snapshot && !boards.has(project)) {
    boards.set(project, snapshot);
    while (boards.size > maxBoardProjects) boards.delete(boards.keys().next().value!);
  }
  return boards.get(project);
}

export function cachedTaskDetail(project: string, taskId: string) {
  return details.get(detailKey(project, taskId));
}

export function cacheTaskDetail(project: string, task: BeadsTaskDetail) {
  const key = detailKey(project, task.id);
  const snapshot = { value: task, savedAt: nextSavedAt() };
  details.delete(key);
  details.set(key, snapshot);
  while (details.size > maxTaskDetails) details.delete(details.keys().next().value!);
  return persist({
    project,
    kind: "detail",
    taskId: task.id,
    value: task,
    savedAt: snapshot.savedAt,
  });
}

export function projectTaskPatch(
  groups: IssueGroup[],
  taskId: string,
  patch: BeadsTaskPatch,
): IssueGroup[] {
  let changed = false;
  const next = groups.map((group) => {
    const items = group.items.map((item) => {
      if (item.id !== taskId) return item;
      changed = true;
      return {
        ...item,
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.status !== undefined ? { done: patch.status === "closed" } : {}),
        ...(patch.priority !== undefined ? { priority: `P${patch.priority}` as const } : {}),
        ...(patch.assignee !== undefined
          ? { assignee: patch.assignee ? { name: patch.assignee } : undefined }
          : {}),
        ...(patch.labels !== undefined ? { labels: [...patch.labels] } : {}),
      };
    });
    return { ...group, items };
  });
  if (!changed || patch.status === undefined) return next;

  const originalGroups = new Map(groups.map((group) => [group.id, group]));
  const projected = new Map<string, IssueGroup>();
  for (const group of next) {
    for (const item of group.items) {
      const status = item.id === taskId ? patch.status : group.id;
      const template =
        originalGroups.get(status) ??
        ({
          ...group,
          id: status,
          title: status,
          source: {
            label: `bd list · ${status}`,
            detail: `Beads tasks grouped locally by status: ${status}`,
          },
        } satisfies IssueGroup);
      const target = projected.get(status) ?? { ...template, items: [] };
      target.items.push(item);
      projected.set(status, target);
    }
  }
  return [...projected.values()];
}

export async function hydrateTaskDetail(project: string, taskId: string) {
  const key = detailKey(project, taskId);
  const snapshot = await readSnapshot<BeadsTaskDetail>(key);
  if (snapshot && !details.has(key)) {
    details.set(key, snapshot);
    while (details.size > maxTaskDetails) details.delete(details.keys().next().value!);
  }
  return details.get(key);
}

export function forgetTaskGroups(project: string) {
  boards.delete(project);
}

export function resetTaskSnapshotsForTest() {
  boards.clear();
  details.clear();
  database = undefined;
}

function boardKey(project: string) {
  return `board:${encodeURIComponent(project)}`;
}

function detailKey(project: string, taskId: string) {
  return `detail:${encodeURIComponent(project)}:${encodeURIComponent(taskId)}`;
}

function nextSavedAt() {
  lastSavedAt = Math.max(Date.now(), lastSavedAt + 1);
  return lastSavedAt;
}

async function persist(snapshot: Omit<StoredSnapshot, "key">) {
  try {
    const db = await openDatabase();
    const transaction = db.transaction(storeName, "readwrite");
    transaction.objectStore(storeName).put({
      ...snapshot,
      key:
        snapshot.kind === "board"
          ? boardKey(snapshot.project)
          : detailKey(snapshot.project, snapshot.taskId!),
    } satisfies StoredSnapshot);
    await transactionDone(transaction);
    await prune(snapshot.kind);
  } catch {
    return;
  }
}

async function readSnapshot<T>(key: string): Promise<Snapshot<T> | undefined> {
  try {
    const db = await openDatabase();
    const transaction = db.transaction(storeName, "readonly");
    const completed = transactionDone(transaction);
    const request = transaction.objectStore(storeName).get(key);
    const stored = await requestResult(request);
    await completed;
    if (!stored || !validStoredSnapshot(stored)) return undefined;
    return { value: stored.value as T, savedAt: stored.savedAt };
  } catch {
    return undefined;
  }
}

async function prune(kind: StoredSnapshot["kind"]) {
  const db = await openDatabase();
  const transaction = db.transaction(storeName, "readwrite");
  const completed = transactionDone(transaction);
  const store = transaction.objectStore(storeName);
  const snapshots = (await requestResult(store.getAll())) as StoredSnapshot[];
  const matching = snapshots
    .filter((snapshot) => snapshot.kind === kind)
    .sort((a, b) => b.savedAt - a.savedAt);
  const limit = kind === "board" ? maxBoardProjects : maxTaskDetails;
  for (const snapshot of matching.slice(limit)) store.delete(snapshot.key);
  await completed;
}

function validStoredSnapshot(value: unknown): value is StoredSnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Partial<StoredSnapshot>;
  return (
    typeof snapshot.project === "string" &&
    (snapshot.kind === "board" || snapshot.kind === "detail") &&
    typeof snapshot.savedAt === "number" &&
    "value" in snapshot
  );
}

function openDatabase() {
  if (!database) {
    database = new Promise((resolve, reject) => {
      if (typeof indexedDB === "undefined") {
        reject(new Error("IndexedDB unavailable"));
        return;
      }
      const request = indexedDB.open(databaseName, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(storeName)) {
          request.result.createObjectStore(storeName, { keyPath: "key" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  return database;
}

function requestResult<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}
