import { expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createTemporaryDirectory } from "../../fs/tests/support/temporary-directory";
import { createSandboxHarness } from "./support/sandbox";

const hosts = ["github.com", "*.npmjs.org"];

async function networkHarness(
  directory: string,
  options: {
    hook?: boolean;
    hookExit?: number;
    fail?: "allow" | "revoke";
    hosts?: string[];
    dryRun?: boolean;
    existing?: string[];
  } = {},
) {
  const seen = join(directory, "seen.json");
  if (options.hook ?? true) {
    const hooks = join(directory, "hooks");
    await mkdir(hooks, { recursive: true });
    await writeFile(
      join(hooks, "sandbox.create.post.ts"),
      [
        'import { writeFileSync } from "node:fs";',
        `writeFileSync(${JSON.stringify(seen)}, await Bun.stdin.text());`,
        `process.exitCode = ${options.hookExit ?? 0};`,
        "",
      ].join("\n"),
    );
  }
  const setupHosts = options.hosts ?? hosts;
  const harness = await createSandboxHarness({
    directory,
    profile: "tools",
    dryRun: options.dryRun,
    config: {
      sandbox: {
        default_provider: "docker-sbx",
        profiles: {
          tools: setupHosts.length ? { setup: { network: { allow: setupHosts } } } : {},
        },
      },
    },
    run: async (args) => {
      const failing = options.fail === "allow" ? "allow" : "rm";
      if (options.fail && args[0] === "policy" && args[1] === failing) {
        return { exitCode: 1, stdout: "", stderr: "rule refused" };
      }

      if (args[0] === "policy" && args[1] === "ls") {
        const rules = [
          { resource_type: "network", decision: "allow", resources: options.existing ?? [] },
        ];

        return { exitCode: 0, stdout: JSON.stringify({ rules }), stderr: "" };
      }

      return { exitCode: 0, stdout: args[0] === "ls" ? "[]" : "", stderr: "" };
    },
  });

  return { ...harness, seen };
}

function steps(commands: { args: string[] }[]) {
  return commands
    .map(({ args }) => args)
    .filter(
      ({ 0: first, 1: second }) => first === "create" || (first === "policy" && second !== "ls"),
    )
    .map((args) => args.slice(0, args[0] === "policy" ? 3 : 1).join(" "));
}

test("setup hosts are opened for the sandbox before the create post hook and closed after it", async () => {
  await using directory = await createTemporaryDirectory();
  const { service, commands, seen } = await networkHarness(directory.path);

  await service.create({ name: "box" });

  expect(steps(commands)).toEqual(["create", "policy allow network", "policy rm network"]);
  const allow = commands.find(({ args }) => args[1] === "allow")!.args;
  expect(allow).toEqual([
    "policy",
    "allow",
    "network",
    "--sandbox",
    "box",
    "--",
    "github.com,*.npmjs.org",
  ]);
  const revoke = commands.find(({ args }) => args[1] === "rm")!.args;
  expect(revoke).toEqual([
    "policy",
    "rm",
    "network",
    "--sandbox",
    "box",
    "--resource",
    "github.com,*.npmjs.org",
    "--force",
  ]);
  expect(JSON.parse(await readFile(seen, "utf8")).sandbox.setupNetwork).toEqual({ allow: hosts });
});

test("only the hosts Eden opened are removed when a rule already existed", async () => {
  await using directory = await createTemporaryDirectory();
  const { service, commands } = await networkHarness(directory.path, { existing: ["github.com"] });

  await service.create({ name: "box" });

  const allow = commands.find(({ args }) => args[1] === "allow")!.args;
  expect(allow.at(-1)).toBe("*.npmjs.org");
  const revoke = commands.find(({ args }) => args[1] === "rm")!.args;
  expect(revoke).toContain("*.npmjs.org");
});

test("no rule is added or removed when every setup host already exists", async () => {
  await using directory = await createTemporaryDirectory();
  const { service, commands } = await networkHarness(directory.path, { existing: hosts });

  await service.create({ name: "box" });

  expect(steps(commands)).toEqual(["create"]);
});

test("setup hosts are closed again when the create post hook fails", async () => {
  await using directory = await createTemporaryDirectory();
  const { service, commands } = await networkHarness(directory.path, { hookExit: 3 });

  await expect(service.create({ name: "box" })).rejects.toBeInstanceOf(Error);

  expect(steps(commands)).toEqual(["create", "policy allow network", "policy rm network"]);
});

test("a rule that cannot be removed warns with the manual command and keeps the create result", async () => {
  await using directory = await createTemporaryDirectory();
  const { service, warnings } = await networkHarness(directory.path, { fail: "revoke" });

  await service.create({ name: "box" });

  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("may still be open");
  expect(warnings[0]).toContain(
    "sbx policy rm network --sandbox box --resource github.com,*.npmjs.org",
  );
});

test("a rule that cannot be added skips the hook and leaves the sandbox in place", async () => {
  await using directory = await createTemporaryDirectory();
  const { service, commands, seen } = await networkHarness(directory.path, { fail: "allow" });

  const failure = await service.create({ name: "box" }).catch((error: unknown) => error);

  expect((failure as Error).message).toContain("was created and is left in place");
  expect(await Bun.file(seen).exists()).toBe(false);
  expect(steps(commands)).toEqual(["create", "policy allow network"]);
});

test("no rules are touched without a setup setting or without a create post hook", async () => {
  await using directory = await createTemporaryDirectory();
  const noSetting = await networkHarness(directory.path, { hosts: [] });
  await noSetting.service.create({ name: "box" });

  expect(steps(noSetting.commands)).toEqual(["create"]);

  const noHook = await networkHarness(join(directory.path, "other"), { hook: false });
  await noHook.service.create({ name: "box" });

  expect(steps(noHook.commands)).toEqual(["create"]);
});

test("dry-run records the setup network changes without running them", async () => {
  await using directory = await createTemporaryDirectory();
  const { service, execution, commands } = await networkHarness(directory.path, { dryRun: true });

  await service.create({ name: "box" });

  expect(execution.operations.map(({ type }) => type)).toEqual([
    "sandbox.create",
    "sandbox.network.allow",
    "hook.run",
    "sandbox.network.revoke",
  ]);
  expect(steps(commands)).toEqual([]);
});
