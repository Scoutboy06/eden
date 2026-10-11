import { expect, test } from "bun:test";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { createExecution } from "../../execution";
import { FilesystemService } from "../fs.service";
import { withTemporaryDirectory } from "./support/temporary-directory";

test("mkdir creates nested directories in normal execution", async () => {
  await withTemporaryDirectory(async (directory) => {
    const fs = new FilesystemService(createExecution({ dryRun: false }));
    const path = join(directory, "parent", "child");

    await fs.mkdir(path);

    expect((await stat(path)).isDirectory()).toBe(true);
  });
});

test("mkdir does not create directories during dry-run", async () => {
  await withTemporaryDirectory(async (directory) => {
    const fs = new FilesystemService(createExecution({ dryRun: true }));
    const path = join(directory, "not-created");

    await fs.mkdir(path);

    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

test("mkdir records the requested filesystem operation", async () => {
  await withTemporaryDirectory(async (directory) => {
    const execution = createExecution({ dryRun: true });
    const fs = new FilesystemService(execution);
    const path = join(directory, "requested");

    await fs.mkdir(path);

    expect(execution.operations).toEqual([
      { type: "fs.mkdir", description: `Create directory ${path}`, input: { path } },
    ]);
  });
});

test("mkdir propagates existing-file errors without altering the file", async () => {
  await withTemporaryDirectory(async (directory) => {
    const fs = new FilesystemService(createExecution({ dryRun: false }));
    const path = join(directory, "existing-file");
    await Bun.write(path, "unchanged");

    await expect(fs.mkdir(path)).rejects.toMatchObject({ code: "EEXIST" });

    expect(await Bun.file(path).text()).toBe("unchanged");
  });
});
