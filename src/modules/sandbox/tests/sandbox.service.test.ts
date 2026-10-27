import { expect, test } from "bun:test";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { createFileConfigService } from "../../config/config.service";
import { findRepositoryPath } from "../../config/repository";
import { createExecution } from "../../execution";
import { withTemporaryDirectory } from "../../fs/tests/support/temporary-directory";
import { createSandboxService, SandboxService } from "../sandbox.service";
import type { SandboxProvider } from "../provider";

test("dry-run checks prerequisites but never calls creation", async () => {
  const execution = createExecution({ dryRun: true });
  const calls: string[] = [];
  const provider: SandboxProvider = {
    name: "docker-sbx",
    readinessChecks: () => [],
    preflight: async () => {
      calls.push("preflight");
    },
    list: async () => [],
    run: async () => 0,
    create: async () => {
      calls.push("create");
    },
  };

  await new SandboxService(execution, provider).create({ name: "example" });

  expect(calls).toEqual(["preflight"]);
  expect(execution.operations).toHaveLength(1);
});

test("an explicit provider skips reading default configuration", async () => {
  const service = await createSandboxService(createExecution({ dryRun: true }), "docker-sbx", {
    read: async () => {
      throw new Error("Must not read");
    },
  });

  expect(service.providerName).toBe("docker-sbx");
});

test("an omitted provider uses the configured default or reports an actionable error", async () => {
  const execution = createExecution({ dryRun: true });
  const service = await createSandboxService(execution, undefined, {
    read: async () => ({
      worktree_root: "/worktrees",
      sandbox: { default_provider: "docker-sbx" },
    }),
  });

  expect(service.providerName).toBe("docker-sbx");
  await expect(
    createSandboxService(execution, undefined, {
      read: async () => ({ worktree_root: "/worktrees" }),
    }),
  ).rejects.toThrow("eden setup");
});

test("repository default provider is resolved from a nested directory without invoking Git", async () => {
  await withTemporaryDirectory(async (directory) => {
    const repository = join(directory, "repository");
    const nested = join(repository, "src", "nested");
    const global = join(directory, "global.yaml");
    await mkdir(nested, { recursive: true });
    await mkdir(join(repository, ".git"));
    await mkdir(join(repository, ".eden"));
    await writeFile(global, "worktree_root: /global\n");
    await writeFile(
      join(repository, ".eden", "config.yaml"),
      "sandbox: { default_provider: docker-sbx }\n",
    );
    const root = await findRepositoryPath(nested);

    const config = createFileConfigService({
      pathsLowToHigh: [global, join(root!, ".eden", "config.yaml")],
    });
    const service = await createSandboxService(
      createExecution({ dryRun: true }),
      undefined,
      config,
    );

    expect(root).toBe(repository);
    expect(service.providerName).toBe("docker-sbx");
  });
});
