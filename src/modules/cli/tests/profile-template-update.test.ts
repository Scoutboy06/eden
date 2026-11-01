import { expect, test } from "bun:test";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stringify } from "yaml";
import { withTemporaryDirectory } from "../../fs/tests/support/temporary-directory";
import { installExecutable, pathWith } from "../../fs/tests/support/executable";
import { runCliWith } from "./support/cli";

type TemplateOptions = {
  cwd: string;
  env: Record<string, string> & {
    EDEN_TEMPLATE_LOG: string;
    EDEN_TEMPLATE_STATE: string;
    EDEN_TEMPLATE_DIGEST: string;
    EDEN_TEMPLATE_IMAGE_ID: string;
  };
};

async function setup(directory: string): Promise<TemplateOptions> {
  await installExecutable(
    new URL("./fixtures/docker-template.ts", import.meta.url),
    directory,
    "docker",
  );
  await installExecutable(new URL("./fixtures/sbx-template.ts", import.meta.url), directory, "sbx");
  const config = join(directory, "config");
  await mkdir(join(config, "eden"), { recursive: true });
  await writeFile(
    join(config, "eden", "config.yaml"),
    stringify({
      sandbox: {
        default_provider: "docker-sbx",
        profiles: { work: { template: "registry.example/team/image:latest" } },
      },
    }),
  );
  return {
    cwd: directory,
    env: {
      PATH: pathWith(directory),
      XDG_CONFIG_HOME: config,
      XDG_CACHE_HOME: join(directory, "cache"),
      EDEN_TEMPLATE_LOG: join(directory, "commands"),
      EDEN_TEMPLATE_STATE: join(directory, "state"),
      EDEN_TEMPLATE_DIGEST: `sha256:${"a".repeat(64)}`,
      EDEN_TEMPLATE_IMAGE_ID: `sha256:${"b".repeat(64)}`,
    },
  };
}

async function commands(path: string): Promise<string[][]> {
  return (await Bun.file(path).text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

test("updates by immutable digest, verifies loaded image, and then becomes a no-op", async () => {
  await withTemporaryDirectory(async (directory) => {
    const options = await setup(directory);

    const first = await runCliWith(options, "profile", "update-template", "work", "--json");
    const previous = await commands(options.env.EDEN_TEMPLATE_LOG);
    const second = await runCliWith(options, "profile", "update-template", "work", "--json");
    const later = (await commands(options.env.EDEN_TEMPLATE_LOG)).slice(previous.length);

    expect(first.exitCode).toBe(0);
    expect(JSON.parse(first.stdout).template).toMatchObject({
      status: "updated",
      sandboxes: {
        current: [],
        outdated: [],
        unattributed: [],
        unavailable: [],
        listUnavailable: false,
      },
    });
    expect(
      previous.some(
        (args) =>
          args[1] === "image" &&
          args[2] === "pull" &&
          args.at(-1)?.endsWith(`@${options.env.EDEN_TEMPLATE_DIGEST}`),
      ),
    ).toBe(true);
    expect(previous.some((args) => args[0] === "sbx" && args[2] === "load")).toBe(true);
    expect(JSON.parse(second.stdout).template.status).toBe("current");
    expect(later.map((args) => args.slice(0, 3))).toEqual([
      ["docker", "buildx", "imagetools"],
      ["sbx", "template", "ls"],
      ["sbx", "ls", "--json"],
    ]);
  });
});

test("dry-run inspects but never creates cache, pulls or loads", async () => {
  await withTemporaryDirectory(async (directory) => {
    const options = await setup(directory);

    const result = await runCliWith(
      options,
      "profile",
      "update-template",
      "work",
      "--dry-run",
      "--json",
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).operations[0]).toMatchObject({
      type: "sandbox.template.update",
      input: { cached: false, outdatedSandboxes: null },
    });
    expect((await commands(options.env.EDEN_TEMPLATE_LOG)).map((args) => args.slice(0, 3))).toEqual(
      [
        ["docker", "buildx", "imagetools"],
        ["sbx", "template", "ls"],
      ],
    );
    expect(await Bun.file(join(directory, "state")).exists()).toBe(false);
    expect(await Bun.file(join(directory, "cache", "eden", "templates")).exists()).toBe(false);
  });
});

test("rejects a pulled image whose digest differs before tagging or loading", async () => {
  await withTemporaryDirectory(async (directory) => {
    const options = await setup(directory);
    options.env.EDEN_TEMPLATE_WRONG_DIGEST = `sha256:${"c".repeat(64)}`;

    const result = await runCliWith(options, "profile", "update-template", "work", "--json");

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).error).toMatchObject({
      code: "SANDBOX_TEMPLATE_UPDATE_FAILED",
      message: expect.stringContaining("did not verify"),
    });
    expect(
      (await commands(options.env.EDEN_TEMPLATE_LOG)).some(
        (args) => args[2] === "tag" || args[2] === "load",
      ),
    ).toBe(false);
  });
});

test("verified cache is reused if template disappears, but a damaged archive is not", async () => {
  await withTemporaryDirectory(async (directory) => {
    const options = await setup(directory);
    expect(
      (await runCliWith(options, "profile", "update-template", "work", "--json")).exitCode,
    ).toBe(0);
    await Bun.write(options.env.EDEN_TEMPLATE_STATE, "cccccccccccc");
    let start = (await commands(options.env.EDEN_TEMPLATE_LOG)).length;

    expect(
      (await runCliWith(options, "profile", "update-template", "work", "--json")).exitCode,
    ).toBe(0);
    let next = (await commands(options.env.EDEN_TEMPLATE_LOG)).slice(start);
    expect(next.some((args) => args[2] === "load")).toBe(true);
    expect(next.some((args) => args[2] === "pull")).toBe(false);

    const cache = join(directory, "cache", "eden", "templates");
    const archive = (await readdir(cache)).find((name) => name.endsWith(".tar"))!;
    await Bun.write(join(cache, archive), "damaged");
    await Bun.write(options.env.EDEN_TEMPLATE_STATE, "cccccccccccc");
    start = (await commands(options.env.EDEN_TEMPLATE_LOG)).length;
    expect(
      (await runCliWith(options, "profile", "update-template", "work", "--json")).exitCode,
    ).toBe(0);
    next = (await commands(options.env.EDEN_TEMPLATE_LOG)).slice(start);
    expect(next.some((args) => args[2] === "pull")).toBe(true);
  });
});

test("a changed registry digest triggers an update without touching sandboxes", async () => {
  await withTemporaryDirectory(async (directory) => {
    const options = await setup(directory);
    expect(
      (await runCliWith(options, "profile", "update-template", "work", "--json")).exitCode,
    ).toBe(0);
    const start = (await commands(options.env.EDEN_TEMPLATE_LOG)).length;
    options.env.EDEN_TEMPLATE_DIGEST = `sha256:${"d".repeat(64)}`;

    const result = await runCliWith(options, "profile", "update-template", "work", "--json");
    const next = (await commands(options.env.EDEN_TEMPLATE_LOG)).slice(start);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).template.status).toBe("updated");
    expect(
      next.some(
        (args) =>
          args[2] === "pull" && args.at(-1)?.endsWith(`@${options.env.EDEN_TEMPLATE_DIGEST}`),
      ),
    ).toBe(true);
    expect(
      next
        .filter((args) => args[0] === "sbx")
        .every((args) => args[1] === "template" || args[1] === "ls" || args[1] === "inspect"),
    ).toBe(true);
  });
});

test("load failure reports that the template may have changed", async () => {
  await withTemporaryDirectory(async (directory) => {
    const options = await setup(directory);
    options.env.EDEN_TEMPLATE_LOAD_FAIL = "1";

    const result = await runCliWith(options, "profile", "update-template", "work", "--json");

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).error.message).toContain("template may already have changed");
    expect(
      (await readdir(join(directory, "cache", "eden", "templates"))).some((name) =>
        name.endsWith(".json"),
      ),
    ).toBe(false);
  });
});

test("uses provider image ID and reports sandbox attribution without exposing inspect fields", async () => {
  await withTemporaryDirectory(async (directory) => {
    const options = await setup(directory);
    const providerId = `sha256:${"e".repeat(64)}`;
    options.env.EDEN_TEMPLATE_SBX_IMAGE_ID = providerId;
    options.env.EDEN_TEMPLATE_SANDBOXES = JSON.stringify([
      { name: "current" },
      { name: "old" },
      { name: "other" },
      { name: "broken" },
    ]);
    options.env.EDEN_TEMPLATE_INSPECT = JSON.stringify({
      current: {
        image: "registry.example/team/image:latest",
        image_digest: providerId,
        secrets: ["must-not-appear"],
      },
      old: {
        image: "registry.example/team/image:latest",
        image_digest: `sha256:${"f".repeat(64)}`,
      },
      other: { image: "registry.example/team/other:latest", image_digest: providerId },
    });

    const result = await runCliWith(options, "profile", "update-template", "work", "--json");

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).template.sandboxes).toEqual({
      current: ["current"],
      outdated: ["old"],
      unattributed: ["other"],
      unavailable: ["broken"],
      listUnavailable: false,
    });
    expect(result.stdout).not.toContain("must-not-appear");
    expect(
      (await runCliWith(options, "profile", "update-template", "work", "--json")).exitCode,
    ).toBe(0);
  });
});
