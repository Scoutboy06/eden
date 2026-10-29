import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stringify } from "yaml";
import { createFileConfigService } from "../config.service";
import { withTemporaryDirectory } from "../../fs/tests/support/temporary-directory";

test.each(["", null, 3, false, [], {}].map((value) => ({ value })))(
  "rejects invalid default profile %j",
  async ({ value }) => {
    await withTemporaryDirectory(async (directory) => {
      const path = join(directory, "config.yaml");
      await writeFile(path, stringify({ sandbox: { default_profile: value } }));

      await expect(
        createFileConfigService({ pathsLowToHigh: [path] }).read(),
      ).rejects.toMatchObject({
        code: "CONFIG_SCHEMA_INVALID",
        issues: expect.arrayContaining([
          expect.objectContaining({ path: "sandbox.default_profile" }),
        ]),
      });
    });
  },
);

test("default profile merges across layers and retains provenance without checking references", async () => {
  await withTemporaryDirectory(async (directory) => {
    const paths = [
      join(directory, "global.yaml"),
      join(directory, "repository.yaml"),
      join(directory, "local.yaml"),
    ] as const;
    for (const [index, path] of paths.entries()) {
      await writeFile(
        path,
        stringify({ sandbox: { default_profile: ["global", "repository", "local"][index] } }),
      );
    }

    const { config, provenance } = await createFileConfigService({
      pathsLowToHigh: paths,
    }).readWithProvenance();

    expect(config.sandbox).toEqual({ default_profile: "local" });
    expect(provenance["sandbox.default_profile"]).toEqual({ type: "file", path: paths[2] });
  });
});
