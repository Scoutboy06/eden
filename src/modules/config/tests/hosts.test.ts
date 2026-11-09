import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createExecution } from "../../execution";
import { withTemporaryDirectory } from "../../fs/tests/support/temporary-directory";
import { createFileConfigService } from "../config.service";

async function fixture(directory: string, dryRun = false) {
  const path = join(directory, "config.yaml");
  const execution = createExecution({ dryRun });
  const config = createFileConfigService({ pathsLowToHigh: [path], execution });
  return { path, execution, config };
}

test("host operations preserve unrelated global YAML, rename, and remove locally", async () => {
  await withTemporaryDirectory(async (directory) => {
    const { path, config } = await fixture(directory);
    const initial =
      "agent:\n  default: claude\nprojects:\n  local:\n    name: Local\n    path: /tmp/local\n";
    await writeFile(path, initial);

    await config.addHost("work", "https://example.test:8443");
    await config.updateHost("work", { newAlias: "office", url: "http://192.0.2.1" });
    expect(await config.read()).toMatchObject({
      agent: { default: "claude" },
      projects: { local: { name: "Local", path: "/tmp/local" } },
      hosts: { office: { url: "http://192.0.2.1" } },
    });
    await config.removeHost("office");
    expect((await config.read()).hosts).toEqual({});
  });
});

test("host operations reject duplicates, unknown aliases, collisions, and invalid values", async () => {
  await withTemporaryDirectory(async (directory) => {
    const { config } = await fixture(directory);
    await config.addHost("work", "https://example.test");
    await config.addHost("office", "http://192.0.2.1");

    await expect(config.addHost("work", "https://example.test")).rejects.toThrow("already exists");
    await expect(config.updateHost("missing", { url: "https://example.test" })).rejects.toThrow(
      "not found",
    );
    await expect(config.removeHost("missing")).rejects.toThrow("not found");
    await expect(config.updateHost("work", { newAlias: "office" })).rejects.toThrow(
      "already exists",
    );
    for (const [alias, url] of [
      ["Bad", "https://example.test"],
      ["bad_alias", "https://example.test"],
      ["bad", "ftp://example.test"],
      ["bad", "http:example.test"],
      ["bad", "https://user:secret@example.test"],
      ["bad", "https://example.test/path"],
      ["bad", "https://example.test/a/.."],
      ["bad", "https://example.test\\path"],
      ["bad", "https://example.test?"],
      ["bad", "https://example.test/#fragment"],
    ] as const) {
      await expect(config.addHost(alias, url)).rejects.toThrow();
    }
  });
});

test("host dry-run records the mutation without writing", async () => {
  await withTemporaryDirectory(async (directory) => {
    const { path, execution, config } = await fixture(directory, true);
    await writeFile(path, "agent:\n  default: claude\n");

    await config.addHost("work", "https://example.test");

    expect(execution.operations).toHaveLength(1);
    expect(await readFile(path, "utf8")).toBe("agent:\n  default: claude\n");
  });
});
