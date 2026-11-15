import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createTemporaryDirectory } from "../../fs/tests/support/temporary-directory";
import { createFileConfigService } from "../config.service";

test("legacy project YAML is excluded from effective configuration", async () => {
  await using directory = await createTemporaryDirectory();
  const path = join(directory.path, "config.yaml");
  await writeFile(
    path,
    'projects:\n  "Inet.Server":\n    name: Inet.Server\n    path: ~/src/inet/../eden\n',
  );

  const config = await createFileConfigService({ pathsLowToHigh: [path] }).read();
  expect(config).not.toHaveProperty("projects");
  expect(await Bun.file(path).text()).toContain("projects:");
});

test("malformed legacy project entries do not prevent unrelated config reads", async () => {
  await using directory = await createTemporaryDirectory();
  const path = join(directory.path, "config.yaml");
  await writeFile(path, "agent:\n  default: codex\nprojects:\n  broken: nope\n");

  expect((await createFileConfigService({ pathsLowToHigh: [path] }).read()).agent?.default).toBe(
    "codex",
  );
});
