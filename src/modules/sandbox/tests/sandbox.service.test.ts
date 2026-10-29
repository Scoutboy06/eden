import { expect, test } from "bun:test";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { createFileConfigService } from "../../config/config.service";
import { findRepositoryPath } from "../../config/repository";
import { createExecution } from "../../execution";
import { withTemporaryDirectory } from "../../fs/tests/support/temporary-directory";
import { createSandboxService, SandboxService } from "../sandbox.service";
import type { SandboxProvider } from "../provider";

test.each([
  ["running", false, true],
  ["stopped", false, false],
  ["running", true, false],
  ["stopped", true, false],
] as const)("stop handles status=%s, dryRun=%s", async (status, dryRun, shouldStop) => {
  const execution = createExecution({ dryRun });
  const calls: string[] = [];
  const provider: SandboxProvider = {
    name: "docker-sbx",
    readinessChecks: () => [],
    preflight: async () => {
      throw new Error("Stop must not check creation prerequisites");
    },
    list: async () => [{ provider: "docker-sbx", name: "example", status }],
    run: async () => {
      throw new Error("Stop must not attach");
    },
    create: async () => {
      throw new Error("Stop must not create");
    },
    stop: async (name) => {
      calls.push(name);
    },
  };

  await new SandboxService(execution, provider).stop("example");

  expect(calls).toEqual(shouldStop ? ["example"] : []);
  expect(execution.operations).toEqual([
    {
      type: "sandbox.stop",
      description: "Stop sandbox example using docker-sbx",
      input: { provider: "docker-sbx", name: "example" },
    },
  ]);
});

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
    stop: async () => {},
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

test.each([undefined, "explicit:image"])(
  "profile creation resolves image=%s without forwarding profile metadata",
  async (image) => {
    const execution = createExecution({ dryRun: false });
    const calls: unknown[] = [];
    const provider: SandboxProvider = {
      name: "docker-sbx",
      readinessChecks: () => [],
      preflight: async () => {
        calls.push("preflight");
      },
      list: async () => [],
      run: async () => 0,
      stop: async () => {},
      create: async (input) => {
        calls.push(input);
      },
    };
    const service = new SandboxService(execution, provider, {
      name: "work",
      template: "profile:image",
    });

    await service.create({ name: "example", image });

    expect(calls).toEqual(["preflight", { name: "example", image: image ?? "profile:image" }]);
    expect(execution.operations[0]?.input).toEqual({
      provider: "docker-sbx",
      name: "example",
      image: image ?? "profile:image",
      profile: "work",
    });
  },
);

test("an explicit provider still reads and validates a selected profile once", async () => {
  let reads = 0;
  const config = {
    read: async () => {
      reads++;

      return {
        worktree_root: "/trees",
        sandbox: { profiles: { work: { template: "profile:image" } } },
      };
    },
  };

  const service = await createSandboxService(
    createExecution({ dryRun: true }),
    "docker-sbx",
    config,
    undefined,
    "work",
  );

  expect(service.providerName).toBe("docker-sbx");
  expect(reads).toBe(1);
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
