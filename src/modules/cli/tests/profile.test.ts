import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stringify } from "yaml";
import { withTemporaryDirectory } from "../../fs/tests/support/temporary-directory";
import { runCliWith } from "./support/cli";
import { prepareSandboxCli } from "./support/sandbox";

test("profile list and show report effective values and their actual sources", async () => {
  await withTemporaryDirectory(async (directory) => {
    const options = await prepareSandboxCli(directory, "missing");
    const global = join(options.env.XDG_CONFIG_HOME!, "eden", "config.yaml");
    const shared = join(directory, ".eden", "config.yaml");
    const local = join(directory, ".eden", "config.local.yaml");
    await mkdir(join(directory, ".git"));
    await mkdir(join(directory, ".eden"));
    await mkdir(join(directory, "nested"));
    await writeFile(
      global,
      stringify({
        sandbox: {
          default_provider: "docker-sbx",
          profiles: { "work.profile": { agent: "claude", template: "global:image" }, empty: {} },
        },
      }),
    );
    await writeFile(
      shared,
      stringify({ sandbox: { profiles: { "work.profile": { template: "repo:image" } } } }),
    );
    await writeFile(
      local,
      stringify({ sandbox: { profiles: { "work.profile": { pull: "never" } } } }),
    );
    const nested = { ...options, cwd: join(directory, "nested") };

    const list = await runCliWith(nested, "profile", "list", "--json");
    const show = await runCliWith(nested, "profile", "show", "work.profile", "--json");
    const humanList = await runCliWith(nested, "profile", "list");
    const human = await runCliWith(nested, "profile", "show", "work.profile");

    expect(list.exitCode).toBe(0);
    expect(JSON.parse(list.stdout).profiles.map((p: { name: string }) => p.name)).toEqual([
      "empty",
      "work.profile",
    ]);
    const profile = JSON.parse(show.stdout).profile;
    expect(profile).toMatchObject({
      name: "work.profile",
      provider: "docker-sbx",
      profile: { agent: "claude", template: "repo:image", pull: "never" },
      sources: [global, local, shared].sort(),
      providerSource: { type: "file", path: global },
    });
    expect(Object.values(profile.provenance)).toContainEqual({ type: "file", path: shared });
    expect(humanList.stdout).toContain("work.profile");
    expect(humanList.stdout).toContain(local);
    expect(human.stdout).toContain(shared);
    expect(human.stdout).toContain("repo:image");
  });
});

test("profile inspection handles empty, missing, and literal names", async () => {
  await withTemporaryDirectory(async (directory) => {
    const options = await prepareSandboxCli(directory, "missing");
    const empty = await runCliWith(options, "profile", "list");
    const missing = await runCliWith(options, "profile", "show", "constructor", "--json");
    await writeFile(
      join(options.env.XDG_CONFIG_HOME!, "eden", "config.yaml"),
      'sandbox: { profiles: { "__proto__": {} } }\n',
    );
    const literal = await runCliWith(options, "profile", "show", "__proto__", "--json");

    expect(empty.stdout).toContain("No sandbox profiles");
    expect(JSON.parse(missing.stdout).error.code).toBe("SANDBOX_PROFILE_NOT_FOUND");
    expect(JSON.parse(literal.stdout).profile).toMatchObject({
      name: "__proto__",
      sources: [join(options.env.XDG_CONFIG_HOME!, "eden", "config.yaml")],
      profile: {},
    });
  });
});
