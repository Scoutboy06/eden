import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createFileConfigService } from "../../config/config.service";
import { findRepositoryPath } from "../../config/repository";
import { rootPrefix } from "../../config/tests/support/root";
import { createExecution } from "../../execution";
import { withTemporaryDirectory } from "../../fs/tests/support/temporary-directory";
import {
  createSandboxProvider,
  createSandboxServiceFactory,
  SandboxService,
} from "../sandbox.service";
import type { SandboxProvider } from "../provider";

test("sandbox construction passes resolved selection and IO options to its provider factory", async () => {
  const execution = createExecution({ dryRun: false });
  const provider = createSandboxProvider("docker-sbx");
  const calls: Parameters<typeof createSandboxProvider>[] = [];
  const onOutput = () => {};

  const createService = createSandboxServiceFactory(
    execution,
    {
      read: async () => ({
        worktree_root: rootPrefix,
        sandbox: { profiles: { work: { provider: "docker-sbx" } } },
      }),
    },
    { onCreateOutput: onOutput, interactiveCreate: true },
    undefined,
    (...args) => {
      calls.push(args);
      return provider;
    },
  );

  const service = await createService({
    profile: "work",
    useDefaultProfile: false,
  });

  expect(service.providerName).toBe("docker-sbx");
  expect(calls).toEqual([["docker-sbx", onOutput, true]]);
  expect(execution.operations).toEqual([]);
});

test("an explicit provider skips reading default configuration", async () => {
  const createService = createSandboxServiceFactory(createExecution({ dryRun: true }), {
    read: async () => {
      throw new Error("Must not read");
    },
  });

  const service = await createService({ provider: "docker-sbx" });

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
    const expectedImage = image ?? "profile:image";

    expect(calls).toEqual(["preflight", { name: "example", image: expectedImage }]);
    expect(execution.operations[0]?.input).toEqual({
      provider: "docker-sbx",
      name: "example",
      image: expectedImage,
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

  const createService = createSandboxServiceFactory(createExecution({ dryRun: true }), config);

  const service = await createService({ provider: "docker-sbx", profile: "work" });

  expect(service.providerName).toBe("docker-sbx");
  expect(reads).toBe(1);
});

test("an omitted provider uses the configured default or reports an actionable error", async () => {
  const execution = createExecution({ dryRun: true });
  const createService = createSandboxServiceFactory(execution, {
    read: async () => ({
      worktree_root: "/worktrees",
      sandbox: { default_provider: "docker-sbx" },
    }),
  });
  const createUnconfiguredService = createSandboxServiceFactory(execution, {
    read: async () => ({ worktree_root: "/worktrees" }),
  });

  const service = await createService();

  expect(service.providerName).toBe("docker-sbx");
  await expect(createUnconfiguredService()).rejects.toThrow("eden setup");
});

test("repository default provider is resolved from a nested directory without invoking Git", async () => {
  await withTemporaryDirectory(async (directory) => {
    const repository = join(directory, "repository");
    const nested = join(repository, "src", "nested");
    const global = join(directory, "global.yaml");
    await mkdir(nested, { recursive: true });
    await mkdir(join(repository, ".git"));
    await mkdir(join(repository, ".eden"));
    await writeFile(global, `worktree_root: ${rootPrefix}/global\n`);
    await writeFile(
      join(repository, ".eden", "config.yaml"),
      "sandbox: { default_provider: docker-sbx }\n",
    );
    const root = await findRepositoryPath(nested);

    const config = createFileConfigService({
      pathsLowToHigh: [global, join(root!, ".eden", "config.yaml")],
    });
    const createService = createSandboxServiceFactory(createExecution({ dryRun: true }), config);

    const service = await createService();

    expect(root).toBe(repository);
    expect(service.providerName).toBe("docker-sbx");
  });
});
