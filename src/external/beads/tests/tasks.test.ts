import { expect, test } from "bun:test";

import { parseBeadsTasks } from "../tasks";

const task = {
  id: "eden-8.1",
  title: "Read native tasks",
  status: "custom_status",
  issue_type: "decision",
  priority: 4 as const,
};

test("preserves native summary fields and omits unneeded provider data", () => {
  const result = parseBeadsTasks(
    JSON.stringify([
      {
        ...task,
        assignee: "Elias",
        labels: ["design"],
        description: "large body",
        notes: "private notes",
      },
    ]),
  );

  expect(result).toEqual([{ ...task, assignee: "Elias", labels: ["design"] }]);
});

test("accepts an empty database", () => {
  expect(parseBeadsTasks("[]")).toEqual([]);
});

test.each([
  "not json",
  "null",
  "{}",
  JSON.stringify([{ ...task, priority: 5 }]),
  JSON.stringify([{ ...task, id: null }]),
])("rejects malformed provider data without echoing it: %s", (input) => {
  expect(() => parseBeadsTasks(input)).toThrow("Beads returned an invalid task list.");
});
