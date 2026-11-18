import { expect, test } from "bun:test";
import { join } from "node:path";
import { createTemporaryDirectory } from "../../fs/tests/support/temporary-directory";
import { FileSandboxProfileRegistry, type SandboxProfileRegistry } from "../profile-registry";
import { createSandboxHarness } from "./support/sandbox";

const config = {
  sandbox: { default_provider: "docker-sbx", profiles: { work: { provider: "docker-sbx" } } },
} as const;

function listing(entries: object[]) {
  return async (args: string[]) => ({
    exitCode: 0,
    stdout: args[0] === "ls" ? JSON.stringify(entries) : "",
    stderr: "",
  });
}

test("registry persists records per provider and forgets them", async () => {
  await using directory = await createTemporaryDirectory();
  const registry = new FileSandboxProfileRegistry(join(directory.path, "state", "profiles.json"));
  const entry = { profile: "work", recordedAt: "2026-11-14T10:00:00.000Z" };

  expect(await registry.read("docker-sbx")).toEqual({});

  await registry.record("docker-sbx", "one", entry);
  await registry.record("docker-sbx", "two", entry);
  await registry.forget("docker-sbx", "one");
  await registry.forget("docker-sbx", "missing");

  expect(await registry.read("docker-sbx")).toEqual({ two: entry });
});

test("registry ignores a corrupt or malformed file", async () => {
  await using directory = await createTemporaryDirectory();
  const path = join(directory.path, "profiles.json");
  const registry = new FileSandboxProfileRegistry(path);

  await Bun.write(path, "{ not json");
  expect(await registry.read("docker-sbx")).toEqual({});

  await Bun.write(
    path,
    JSON.stringify({
      "docker-sbx": { bad: { profile: 1 }, good: { profile: "p", recordedAt: "t" } },
    }),
  );
  expect(await registry.read("docker-sbx")).toEqual({ good: { profile: "p", recordedAt: "t" } });
});

test("create records the profile, list shows it and removal forgets it", async () => {
  await using directory = await createTemporaryDirectory();
  const registry = new FileSandboxProfileRegistry(join(directory.path, "profiles.json"));
  const { service } = await createSandboxHarness({
    directory: directory.path,
    profile: "work",
    config,
    registry,
    run: listing([{ name: "example", status: "stopped", created_at: "2000-01-01T00:00:00Z" }]),
  });

  await service.create({ name: "example" });

  expect(await service.list()).toEqual([
    { provider: "docker-sbx", name: "example", status: "stopped", profile: "work" },
  ]);
  expect(await service.profileOf("example")).toBe("work");

  await service.remove("example", { force: true });

  expect(await registry.read("docker-sbx")).toEqual({});
  expect(await service.profileOf("example")).toBeUndefined();
});

test("a sandbox recreated outside Eden does not inherit the old profile", async () => {
  await using directory = await createTemporaryDirectory();
  const registry = new FileSandboxProfileRegistry(join(directory.path, "profiles.json"));
  await registry.record("docker-sbx", "example", {
    profile: "work",
    recordedAt: "2026-11-14T10:00:00.000Z",
  });
  const { service } = await createSandboxHarness({
    directory: directory.path,
    config,
    registry,
    run: listing([{ name: "example", status: "running", created_at: "2026-11-14T11:00:00Z" }]),
  });

  expect(await service.profileOf("example")).toBeUndefined();
});

test("create without a profile and dry-run create record nothing", async () => {
  await using directory = await createTemporaryDirectory();
  const registry = new FileSandboxProfileRegistry(join(directory.path, "profiles.json"));
  const plain = await createSandboxHarness({ directory: directory.path, config, registry });
  const dry = await createSandboxHarness({
    directory: directory.path,
    config,
    registry,
    profile: "work",
    dryRun: true,
  });

  await plain.service.create({ name: "plain" });
  await dry.service.create({ name: "dry" });

  expect(await registry.read("docker-sbx")).toEqual({});
});

test("a failing registry warns without failing create, list or remove", async () => {
  await using directory = await createTemporaryDirectory();
  const failing: SandboxProfileRegistry = {
    read: async () => {
      throw new Error("read denied");
    },
    record: async () => {
      throw new Error("write denied");
    },
    forget: async () => {
      throw new Error("write denied");
    },
  };
  const { service, warnings } = await createSandboxHarness({
    directory: directory.path,
    profile: "work",
    config,
    registry: failing,
    run: listing([{ name: "example", status: "stopped" }]),
  });

  await service.create({ name: "example" });
  await service.remove("example", { force: true });

  expect(await service.list()).toEqual([
    { provider: "docker-sbx", name: "example", status: "stopped" },
  ]);
  expect(warnings).toEqual([
    "Could not remember profile work for sandbox example: write denied",
    "Could not forget the recorded profile of sandbox example: write denied",
  ]);
});

test("a profile-less create forgets an older record of the same name", async () => {
  await using directory = await createTemporaryDirectory();
  const registry = new FileSandboxProfileRegistry(join(directory.path, "profiles.json"));
  await registry.record("docker-sbx", "example", { profile: "work", recordedAt: "t" });
  const { service } = await createSandboxHarness({ directory: directory.path, config, registry });

  await service.create({ name: "example" });

  expect(await registry.read("docker-sbx")).toEqual({});
});
