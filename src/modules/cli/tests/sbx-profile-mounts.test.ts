import { expect, test } from "bun:test";
import { withTemporaryDirectory } from "../../fs/tests/support/temporary-directory";
import { resolveSandboxPaths } from "../../sandbox/sandbox-paths";

test("resolves sandbox and workspace expressions without evaluating shell syntax", async () => {
  await withTemporaryDirectory(async (directory) => {
    const input = {
      name: "example",
      workspace: { mode: "clone" as const, path: directory },
      kitArgs: { name: "${{ sandbox.name }}", path: "${{ workspace.path }}" },
    };
    await resolveSandboxPaths(input);
    expect(input.kitArgs).toEqual({ name: "example", path: directory });
  });
});
