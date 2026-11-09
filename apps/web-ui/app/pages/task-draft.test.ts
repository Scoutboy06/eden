import { expect, test } from "bun:test";

import { refreshedTaskDraft, taskChanges, taskDraft } from "./task-draft";

const task = {
  id: "eden-1",
  title: "Title",
  description: "Body",
  issue_type: "task",
  status: "custom",
  priority: 2 as const,
};

test("unchanged drafts produce no write and preserve native status", () => {
  const draft = taskDraft(task);

  const changes = taskChanges(task, draft);

  expect(changes).toEqual({});
  expect(draft.status).toBe("custom");
});

test("metadata saves preserve unsaved title and description without staging the metadata again", () => {
  const draft = { ...taskDraft(task), title: "Unsaved title", description: "Unsaved description" };
  const saved = { ...task, status: "in_progress", assignee: "Alice", labels: ["review"] };

  const refreshed = refreshedTaskDraft(saved, draft, true);
  const changes = taskChanges(saved, refreshed);

  expect(refreshed).toEqual({
    ...taskDraft(saved),
    title: draft.title,
    description: draft.description,
  });
  expect(changes).toEqual({ title: draft.title, description: draft.description });
});

test("saves only edited fields rather than overwriting unrelated provider values", () => {
  const original = { ...task, assignee: "Elias", labels: ["design"] };
  const draft = { ...taskDraft(original), assignee: "", labels: [], priority: 0 as const };

  const changes = taskChanges(original, draft);

  expect(changes).toEqual({ assignee: "", labels: [], priority: 0 });
});
