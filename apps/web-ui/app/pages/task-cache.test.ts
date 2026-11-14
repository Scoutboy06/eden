import { expect, test } from "bun:test";

import { cachedTaskGroups, cacheTaskGroups, forgetTaskGroups } from "./task-cache";

test("task cache isolates projects, retains empty results, replaces data, and bounds memory", () => {
  expect(cachedTaskGroups("missing")).toBeUndefined();

  const groups = [{ id: "open", title: "Open", items: [] }];
  cacheTaskGroups("eden", []);
  cacheTaskGroups("other", []);

  expect(cachedTaskGroups("eden")).toEqual([]);

  cacheTaskGroups("eden", groups);

  expect(cachedTaskGroups("eden")).toBe(groups);
  expect(cachedTaskGroups("other")).toEqual([]);

  forgetTaskGroups("other");

  expect(cachedTaskGroups("other")).toBeUndefined();
  expect(cachedTaskGroups("eden")).toBe(groups);

  for (let index = 0; index < 20; index++) {
    cacheTaskGroups(`project-${index}`, []);
  }

  expect(cachedTaskGroups("eden")).toBeUndefined();
  expect(cachedTaskGroups("project-19")).toEqual([]);
});
