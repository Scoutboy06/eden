import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createTemporaryDirectory } from "../../fs/tests/support/temporary-directory";
import { deriveSandboxName, findCheckout, pathKey } from "../sandbox-checkout";

test.each([
  ["/home/me/p/Inet.Server", "inet.server"],
  ["/home/me/p/My Project", "my-project"],
  ["/home/me/p/sbx/feature-x/repo", "feature-x"],
  ["/home/me/p/sbx/Feature X/Repo", "feature-x"],
  ["/home/me/p/__weird__name__", "weird-name"],
  ["/home/me/p/a..b", "a.b"],
  ["/home/me/p/" + "x".repeat(80), "x".repeat(63)],
])("derives sandbox name from %s", (path, expected) => {
  expect(deriveSandboxName(path)).toBe(expected);
});

test.each(["/home/me/p/x", "/home/me/p/default", "/home/me/p/___"])(
  "refuses to derive an invalid name from %s",
  (path) => {
    expect(() => deriveSandboxName(path)).toThrow("Pass --name");
  },
);

test("finds the repository root from a nested folder", async () => {
  await using directory = await createTemporaryDirectory();
  await mkdir(join(directory.path, "repo", ".git"), { recursive: true });
  await mkdir(join(directory.path, "repo", "src", "deep"), { recursive: true });

  expect(await pathKey(await findCheckout(join(directory.path, "repo", "src", "deep")))).toBe(
    await pathKey(join(directory.path, "repo")),
  );
});

test("fails outside a checkout", async () => {
  await using directory = await createTemporaryDirectory();
  await expect(findCheckout(directory.path)).rejects.toThrow("Not inside a Git checkout");
});

test("compares paths ignoring separators, trailing slashes and mount suffixes", async () => {
  const base = await pathKey("/tmp/some/dir");

  expect(await pathKey("/tmp/some/dir/")).toBe(base);
  expect(await pathKey("/tmp/some/dir:ro")).toBe(base);
});

test.skipIf(process.platform !== "win32")("compares Windows paths case-insensitively", async () => {
  expect(await pathKey(String.raw`C:\Users\Me\Repo`)).toBe(await pathKey("c:/users/me/repo/"));
});
