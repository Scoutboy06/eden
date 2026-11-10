import { expect, test } from "bun:test";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { withTemporaryDirectory } from "../../fs/tests/support/temporary-directory";
import { runCliWith } from "./support/cli";

test("host commands are wired to the global config and support JSON and dry-run", async () => {
  await withTemporaryDirectory(async (directory) => {
    const xdg = join(directory, "config");
    const configDirectory = join(xdg, "eden");
    const path = join(configDirectory, "config.yaml");
    await mkdir(configDirectory, { recursive: true });
    await Bun.write(path, "agent:\n  default: claude\n");
    const options = { cwd: directory, env: { HOME: directory, XDG_CONFIG_HOME: xdg } };

    const added = await runCliWith(
      options,
      "host",
      "add",
      "work",
      "--url",
      "https://example.test",
      "--json",
    );
    expect(added.exitCode).toBe(0);
    expect(JSON.parse(added.stdout)).toMatchObject({
      ok: true,
      alias: "work",
      url: "https://example.test",
    });

    const shown = await runCliWith(options, "host", "show", "work", "--json");
    expect(JSON.parse(shown.stdout)).toMatchObject({
      ok: true,
      alias: "work",
      url: "https://example.test",
    });

    const dryRun = await runCliWith(
      options,
      "host",
      "update",
      "work",
      "--alias",
      "office",
      "--dry-run",
      "--json",
    );
    expect(JSON.parse(dryRun.stdout)).toMatchObject({ ok: true, dryRun: true });
    expect(await readFile(path, "utf8")).toContain("work:");

    const removed = await runCliWith(options, "host", "remove", "work", "--json");
    expect(removed.exitCode).toBe(0);
    expect(Bun.YAML.parse(await readFile(path, "utf8"))).toMatchObject({ hosts: {} });
  });
});

test("host list and show ignore repository-local host entries", async () => {
  await withTemporaryDirectory(async (directory) => {
    const repository = join(directory, "repository");
    const xdg = join(directory, "config");
    const globalConfig = join(xdg, "eden", "config.yaml");
    await mkdir(join(repository, ".eden"), { recursive: true });
    await mkdir(join(xdg, "eden"), { recursive: true });
    const git = Bun.spawn(["git", "init", "-q"], { cwd: repository, stderr: "pipe" });
    expect(await git.exited).toBe(0);
    await Bun.write(globalConfig, "hosts:\n  global: \n    url: https://global.example\n");
    await Bun.write(
      join(repository, ".eden", "config.yaml"),
      "hosts:\n  global:\n    url: https://local-override.example\n  local-only:\n    url: https://local.example\n",
    );
    const options = { cwd: repository, env: { HOME: directory, XDG_CONFIG_HOME: xdg } };

    const listed = await runCliWith(options, "host", "list", "--json");
    expect(JSON.parse(listed.stdout).hosts).toEqual({ global: { url: "https://global.example" } });

    const shown = await runCliWith(options, "host", "show", "global", "--json");
    expect(JSON.parse(shown.stdout)).toMatchObject({ url: "https://global.example" });

    const localOnly = await runCliWith(options, "host", "show", "local-only", "--json");
    expect(localOnly.exitCode).toBe(1);
    expect(JSON.parse(localOnly.stdout).error.message).toBe("Host not found.");
  });
});
