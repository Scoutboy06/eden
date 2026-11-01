import { expect, test } from "bun:test";
import { sandboxPath } from "../sandbox-paths";

test.each([
  ["C:\\Users\\Example\\cache", "/c/Users/Example/cache"],
  ["D:/work/cache", "/d/work/cache"],
  ["/home/example/cache", "/home/example/cache"],
])("maps host path %s into the sandbox", (host, expected) => {
  expect(sandboxPath(host)).toBe(expected);
});

test("rejects an unsupported UNC sandbox path", () => {
  expect(() => sandboxPath("\\\\server\\share\\data")).toThrow("cannot be represented");
});
