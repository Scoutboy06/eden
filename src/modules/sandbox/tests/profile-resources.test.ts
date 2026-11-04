import { expect, test } from "bun:test";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { withTemporaryDirectory } from "../../fs/tests/support/temporary-directory";
import { createSandboxHarness } from "./support/sandbox";

test("dry-run records resource settings and expanded kit references without creating", async () => {
  await withTemporaryDirectory(async (directory) => {
    const { service, execution, commands } = await createSandboxHarness({
      directory,
      dryRun: true,
      profile: "work",
      config: {
        sandbox: {
          default_provider: "docker-sbx",
          profiles: {
            work: {
              pull: "never",
              disk: { root: "100g" },
              kits: [
                "~/first",
                "~\\second",
                "./third",
                "../fourth",
                "oci://registry/kit",
                "https://example.com/kit.git",
                "vendor/kit",
              ],
            },
          },
        },
      },
    });

    await service.create({ name: "example" });

    expect(execution.operations[0]?.input).toMatchObject({
      pull: "never",
      disk: { root: "100g" },
      kits: [
        join(homedir(), "first"),
        join(homedir(), "second"),
        resolve("third"),
        resolve("../fourth"),
        "oci://registry/kit",
        "https://example.com/kit.git",
        "vendor/kit",
      ],
    });
    expect(commands.map(({ args }) => args)).toEqual([
      ["ls", "--json"],
      ["policy", "ls", "--json"],
    ]);
  });
});
