import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createFileConfigService } from "../../config/config.service";
import { createExecution } from "../../execution";
import { withTemporaryDirectory } from "../../fs/tests/support/temporary-directory";
import {
  SetupCancelled,
  SetupService,
  validateWorktreeRoot,
  type SetupPrompts,
} from "../setup.service";

function prompts(overrides: Partial<SetupPrompts> = {}): SetupPrompts {
  return {
    intro() {},
    provider: async (current) => current,
    worktreeRoot: async (current) => current,
    review: async () => "save",
    confirmOverwrite: async () => false,
    ...overrides,
  };
}

test("first setup uses defaults, saves an explicit root, and does not invent a provider", async () => {
  await withTemporaryDirectory(async (directory) => {
    const path = join(directory, "config.yaml");
    const execution = createExecution({ dryRun: false });
    const service = new SetupService(
      createFileConfigService({ pathsLowToHigh: [path], execution }),
    );

    const result = await service.run(prompts());

    expect(result.status).toBe("saved");
    expect(Bun.YAML.parse(await Bun.file(path).text())).toEqual({ worktree_root: "~/.worktrees" });
    expect(execution.operations).toHaveLength(1);
  });
});

test("reruns preselect saved global values and leave unchanged preferences untouched", async () => {
  await withTemporaryDirectory(async (directory) => {
    const path = join(directory, "config.yaml");
    const source = "worktree_root: ~/.saved\nsandbox:\n  default_provider: docker-sbx\n";
    await writeFile(path, source);
    const execution = createExecution({ dryRun: false });
    const service = new SetupService(
      createFileConfigService({ pathsLowToHigh: [path], execution }),
    );
    const observed: unknown[] = [];

    const result = await service.run(
      prompts({
        async provider(current, saved) {
          observed.push([current, saved]);
          return current;
        },
        async worktreeRoot(current, saved) {
          observed.push([current, saved]);
          return current;
        },
      }),
    );

    expect(result.status).toBe("unchanged");
    expect(observed).toEqual([
      ["docker-sbx", "docker-sbx"],
      ["~/.saved", "~/.saved"],
    ]);
    expect(await Bun.file(path).text()).toBe(source);
    expect(execution.operations).toHaveLength(0);
  });
});

test("review edits keep pending values and do not restart the guided flow", async () => {
  await withTemporaryDirectory(async (directory) => {
    const path = join(directory, "config.yaml");
    const execution = createExecution({ dryRun: false });
    const service = new SetupService(
      createFileConfigService({ pathsLowToHigh: [path], execution }),
    );
    const selected: string[] = [];
    const rootInputs: string[] = [];
    let providerCalls = 0;
    let reviewCalls = 0;

    const result = await service.run(
      prompts({
        async provider() {
          providerCalls++;
          return "docker-sbx";
        },
        async worktreeRoot(current) {
          rootInputs.push(current);
          return rootInputs.length === 1 ? "~/.first" : "~/.second";
        },
        async review(_preferences, current) {
          selected.push(current);
          return reviewCalls++ === 0 ? "worktreeRoot" : "save";
        },
      }),
    );

    expect(result.status).toBe("saved");
    expect(providerCalls).toBe(1);
    expect(rootInputs).toEqual(["~/.worktrees", "~/.first"]);
    expect(selected).toEqual(["save", "worktreeRoot"]);
    expect(Bun.YAML.parse(await Bun.file(path).text())).toEqual({
      worktree_root: "~/.second",
      sandbox: { default_provider: "docker-sbx" },
    });
  });
});

test.each(["provider", "worktreeRoot", "review"] as const)(
  "cancelling at %s writes nothing",
  async (stage) => {
    await withTemporaryDirectory(async (directory) => {
      const path = join(directory, "config.yaml");
      const execution = createExecution({ dryRun: false });
      const service = new SetupService(
        createFileConfigService({ pathsLowToHigh: [path], execution }),
      );
      const interaction = prompts();
      interaction[stage] = async () => {
        throw new SetupCancelled();
      };

      const result = await service.run(interaction);

      expect(result.status).toBe("cancelled");
      expect(await Bun.file(path).exists()).toBe(false);
      expect(execution.operations).toHaveLength(0);
    });
  },
);

test("cancelling an overwrite conflict exits without returning to review", async () => {
  await withTemporaryDirectory(async (directory) => {
    const path = join(directory, "config.yaml");
    const execution = createExecution({ dryRun: false });
    const service = new SetupService(
      createFileConfigService({ pathsLowToHigh: [path], execution }),
    );
    let reviews = 0;

    const result = await service.run(
      prompts({
        async review() {
          reviews++;
          await writeFile(path, "agent: { default: codex }\n");
          return "save";
        },
        confirmOverwrite: async () => false,
      }),
    );

    expect(result.status).toBe("cancelled");
    expect(reviews).toBe(1);
    expect(await Bun.file(path).text()).toBe("agent: { default: codex }\n");
  });
});

test("dry-run completes the flow and records intended changes without writing", async () => {
  await withTemporaryDirectory(async (directory) => {
    const path = join(directory, "config.yaml");
    const execution = createExecution({ dryRun: true });
    const service = new SetupService(
      createFileConfigService({ pathsLowToHigh: [path], execution }),
    );

    const result = await service.run(prompts({ provider: async () => "docker-sbx" }));

    expect(result.status).toBe("previewed");
    expect(result.changes).toEqual({
      "sandbox.default_provider": "docker-sbx",
      worktree_root: "~/.worktrees",
    });
    expect(await Bun.file(path).exists()).toBe(false);
    expect(execution.operations).toHaveLength(1);
  });
});

test("invalid configuration fails through normal config errors before prompts open", async () => {
  await withTemporaryDirectory(async (directory) => {
    const path = join(directory, "config.yaml");
    await writeFile(path, "sandbox: { default_provider: unsupported }\n");
    const execution = createExecution({ dryRun: false });
    const service = new SetupService(
      createFileConfigService({ pathsLowToHigh: [path], execution }),
    );
    let opened = false;

    await expect(
      service.run(
        prompts({
          intro() {
            opened = true;
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "CONFIG_SCHEMA_INVALID" });
    expect(opened).toBe(false);
  });
});

test("worktree paths accept missing directories but reject files and relative paths", async () => {
  await withTemporaryDirectory(async (directory) => {
    const file = join(directory, "file");
    await writeFile(file, "not a directory");
    await mkdir(join(directory, "existing"));

    expect(await validateWorktreeRoot(join(directory, "missing"))).toBeUndefined();
    expect(await validateWorktreeRoot(join(directory, "existing"))).toBeUndefined();
    expect(await validateWorktreeRoot(file)).toContain("not a file");
    expect(await validateWorktreeRoot("relative/path")).toBeDefined();
    expect(await validateWorktreeRoot("/invalid\0path")).toBeDefined();
    expect(await Bun.file(join(directory, "missing")).exists()).toBe(false);
  });
});
