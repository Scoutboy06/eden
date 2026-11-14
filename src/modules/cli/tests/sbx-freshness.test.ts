import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stringify } from "yaml";
import { withTemporaryDirectory } from "../../fs/tests/support/temporary-directory";
import { installExecutable, pathWith } from "../../fs/tests/support/executable";
import { runCliWith } from "./support/cli";

type Options = {
  cwd: string;
  env: Record<string, string> & { EDEN_FRESHNESS_LOG: string; XDG_CACHE_HOME: string };
};
async function setup(directory: string): Promise<Options> {
  await installExecutable(
    new URL("./fixtures/sbx-freshness.ts", import.meta.url),
    directory,
    "sbx",
  );
  await installExecutable(
    new URL("./fixtures/docker-freshness.ts", import.meta.url),
    directory,
    "docker",
  );
  const config = join(directory, "config");
  await mkdir(join(config, "eden"), { recursive: true });
  await writeFile(
    join(config, "eden", "config.yaml"),
    stringify({
      sandbox: {
        default_provider: "docker-sbx",
        profiles: { work: { template: "example/image:tag" } },
      },
    }),
  );
  return {
    cwd: directory,
    env: {
      PATH: pathWith(directory),
      XDG_CONFIG_HOME: config,
      XDG_CACHE_HOME: join(directory, "cache"),
      EDEN_FRESHNESS_LOG: join(directory, "commands"),
    },
  };
}

async function createReceipt(options: Options, reference: string, digest: string, id: string) {
  const platform = process.arch === "arm64" ? "linux/arm64" : "linux/amd64";
  const key = createHash("sha256").update(`${reference}\0${digest}\0${platform}`).digest("hex");
  const path = join(options.env.XDG_CACHE_HOME, "eden", "templates");
  await mkdir(path, { recursive: true });
  await writeFile(
    join(path, `${key}.json`),
    JSON.stringify({ reference, digest, platform, imageId: id, archiveHash: "unused" }),
  );
  return path;
}

test("opt-in checks use verified receipt to classify sandbox images without writes", async () => {
  await withTemporaryDirectory(async (directory) => {
    const options = await setup(directory);
    const digest = `sha256:${"a".repeat(64)}`;
    const currentId = `sha256:${"b".repeat(64)}`;
    const olderId = `sha256:${"c".repeat(64)}`;
    const cache = await createReceipt(options, "example/image:tag", digest, currentId.slice(7, 19));
    const before = await readdir(cache);
    options.env.EDEN_FRESHNESS_SANDBOXES = JSON.stringify([
      { name: "current", status: "running" },
      { name: "old", status: "stopped" },
      { name: "missing", status: "running" },
      { name: "unknown", status: "running" },
    ]);
    options.env.EDEN_FRESHNESS_TEMPLATES = JSON.stringify([
      { repository: "docker.io/example/image", tag: "tag", id: currentId.slice(7, 19) },
    ]);
    options.env.EDEN_FRESHNESS_INSPECT = JSON.stringify({
      current: {
        image: "docker.io/example/image:tag",
        image_digest: currentId,
        secrets: ["do-not-print"],
      },
      old: { image: "example/image:tag", image_digest: olderId },
      missing: { image: "example/missing:tag", image_digest: olderId },
      unknown: { image: "example/image:tag", image_digest: "invalid" },
    });
    options.env.EDEN_FRESHNESS_DIGESTS = JSON.stringify({
      "docker.io/example/image:tag": digest,
      "example/image:tag": digest,
    });

    const result = await runCliWith(options, "sbx", "list", "--check-updates", "--json");

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).sandboxes.map((entry: any) => entry.freshness.state)).toEqual([
      "current",
      "outdated",
      "missing",
      "unknown",
    ]);
    expect(result.stdout).not.toContain("do-not-print");
    expect(await readdir(cache)).toEqual(before);
    const log = (await Bun.file(options.env.EDEN_FRESHNESS_LOG).text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const commandsAreReadOnly = log.every(
      (args: string[]) => args[0] === "sbx" || (args[0] === "docker" && args[1] === "buildx"),
    );
    const fetchedOrLoadedTemplate = log.some(
      (args: string[]) => args.includes("pull") || args.includes("load"),
    );

    expect(commandsAreReadOnly).toBe(true);
    expect(fetchedOrLoadedTemplate).toBe(false);
  });
});

test("registry errors are nonfatal and missing receipts stay unknown", async () => {
  await withTemporaryDirectory(async (directory) => {
    const options = await setup(directory);
    options.env.EDEN_FRESHNESS_SANDBOXES = JSON.stringify([
      { name: "failed", status: "stopped" },
      { name: "unverified", status: "stopped" },
    ]);
    options.env.EDEN_FRESHNESS_TEMPLATES = JSON.stringify([
      { repository: "example/fail", tag: "latest", id: "b".repeat(12) },
      { repository: "example/ok", tag: "latest", id: "b".repeat(12) },
    ]);
    options.env.EDEN_FRESHNESS_INSPECT = JSON.stringify({
      failed: { image: "example/fail:latest", image_digest: `sha256:${"b".repeat(64)}` },
      unverified: { image: "example/ok:latest", image_digest: `sha256:${"b".repeat(64)}` },
    });
    options.env.EDEN_FRESHNESS_DIGESTS = JSON.stringify({
      "example/ok:latest": `sha256:${"a".repeat(64)}`,
    });

    const result = await runCliWith(options, "sbx", "list", "--check-updates", "--json");

    expect(result.exitCode).toBe(0);
    const data = JSON.parse(result.stdout);
    expect(data.sandboxes.map((entry: any) => entry.freshness.state)).toEqual([
      "unknown",
      "unknown",
    ]);
    expect(data.sandboxes[1].freshness.reason).toContain("No verified receipt");
    expect(data.warnings).toHaveLength(1);
    expect(data.warnings[0]).toContain("example/fail:latest");
    expect(await Bun.file(join(options.env.XDG_CACHE_HOME, "eden", "templates")).exists()).toBe(
      false,
    );
  });
});

test("ordinary list does not inspect or contact registries", async () => {
  await withTemporaryDirectory(async (directory) => {
    const options = await setup(directory);
    options.env.EDEN_FRESHNESS_SANDBOXES = JSON.stringify([{ name: "example", status: "running" }]);

    const result = await runCliWith(options, "sbx", "list", "--json");

    expect(result.exitCode).toBe(0);
    expect((await Bun.file(options.env.EDEN_FRESHNESS_LOG).text()).trim().split("\n")).toEqual([
      JSON.stringify(["sbx", "ls", "--json"]),
    ]);
  });
});

test("human output describes unknown status without failing on unavailable metadata", async () => {
  await withTemporaryDirectory(async (directory) => {
    const options = await setup(directory);
    options.env.EDEN_FRESHNESS_SANDBOXES = JSON.stringify([{ name: "example", status: "stopped" }]);
    options.env.EDEN_FRESHNESS_TEMPLATE_FAILURE = "1";
    options.env.EDEN_FRESHNESS_INSPECT = JSON.stringify({
      example: { image: "example/image:tag", image_digest: `sha256:${"b".repeat(64)}` },
    });

    const result = await runCliWith(options, "sbx", "list", "--check-updates");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("example: unknown");
    expect(result.stdout).toContain("template metadata could not be read");
  });
});

test("changed registry digest reports outdated from a prior verified receipt", async () => {
  await withTemporaryDirectory(async (directory) => {
    const options = await setup(directory);
    const oldDigest = `sha256:${"a".repeat(64)}`;
    const newDigest = `sha256:${"d".repeat(64)}`;
    const imageId = `sha256:${"b".repeat(64)}`;
    const cache = await createReceipt(
      options,
      "example/image:tag",
      oldDigest,
      imageId.slice(7, 19),
    );
    const before = await readdir(cache);
    options.env.EDEN_FRESHNESS_SANDBOXES = JSON.stringify([{ name: "example", status: "stopped" }]);
    options.env.EDEN_FRESHNESS_TEMPLATES = JSON.stringify([
      { repository: "example/image", tag: "tag", id: imageId.slice(7, 19) },
    ]);
    options.env.EDEN_FRESHNESS_INSPECT = JSON.stringify({
      example: { image: "example/image:tag", image_digest: imageId },
    });
    options.env.EDEN_FRESHNESS_DIGESTS = JSON.stringify({ "example/image:tag": newDigest });

    const result = await runCliWith(options, "sbx", "list", "--check-updates", "--json");

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).sandboxes[0].freshness).toMatchObject({
      state: "outdated",
      reason: expect.stringContaining("registry manifest has changed"),
    });
    expect(await readdir(cache)).toEqual(before);
    const log = await Bun.file(options.env.EDEN_FRESHNESS_LOG).text();
    expect(log).not.toContain('"pull"');
    expect(log).not.toContain('"load"');
  });
});

test("an unverified loaded-template mismatch is described without guessing which image is newer", async () => {
  await withTemporaryDirectory(async (directory) => {
    const options = await setup(directory);
    options.env.EDEN_FRESHNESS_SANDBOXES = JSON.stringify([{ name: "example", status: "stopped" }]);
    options.env.EDEN_FRESHNESS_TEMPLATES = JSON.stringify([
      { repository: "example/image", tag: "tag", id: "b".repeat(12) },
    ]);
    options.env.EDEN_FRESHNESS_INSPECT = JSON.stringify({
      example: { image: "example/image:tag", image_digest: `sha256:${"c".repeat(64)}` },
    });
    options.env.EDEN_FRESHNESS_DIGESTS = JSON.stringify({
      "example/image:tag": `sha256:${"a".repeat(64)}`,
    });

    const result = await runCliWith(options, "sbx", "list", "--check-updates", "--json");

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).sandboxes[0].freshness).toMatchObject({
      state: "unknown",
      reason: expect.stringContaining("differs from the loaded template"),
    });
  });
});
