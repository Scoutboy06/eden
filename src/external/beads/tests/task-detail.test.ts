import { expect, test } from "bun:test";

import { taskUpdateArguments } from "../task-detail";

test("task updates use explicit argv and preserve clearing and zero values", () => {
  const changes = {
    title: " A title ",
    description: "--status closed\nbody",
    priority: 0,
    assignee: "",
    labels: [],
  };

  const args = taskUpdateArguments("eden-1", changes);

  expect(args).toEqual([
    "update",
    "eden-1",
    "--title",
    "A title",
    "--description",
    "--status closed\nbody",
    "--priority",
    "0",
    "--assignee",
    "",
    "--set-labels",
    "",
  ]);
});

test("label updates deduplicate values and reject ambiguous comma encoding", () => {
  const changes = { labels: ["design", "design", "needs review"] };
  const invalidChanges = { labels: ["a,b"] };

  const args = taskUpdateArguments("eden-1", changes);

  expect(args).toEqual(["update", "eden-1", "--set-labels", "design,needs review"]);
  expect(() => taskUpdateArguments("eden-1", invalidChanges)).toThrow("Invalid task changes");
});

test.each([
  {},
  { title: " " },
  { priority: 5 },
  { assignee: null },
  { labels: [""] },
  { claim: true },
  { status: "" },
  { description: 1 },
])("rejects unsupported/invalid changes before provider execution: %j", (patch) => {
  expect(() => taskUpdateArguments("eden-1", patch)).toThrow("Invalid task changes");
});

test.each(["--all", "../other", "", "a/b", "a\0b"])(
  "rejects non-exact task selectors: %s",
  (id) => {
    expect(() => taskUpdateArguments(id, { title: "Updated" })).toThrow("Invalid task ID");
  },
);
