import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stringify } from "yaml";
import { withTemporaryDirectory } from "../../fs/tests/support/temporary-directory";
import { installExecutable, pathWith } from "../../fs/tests/support/executable";
import { runCliWith } from "./support/cli";

const digest = `sha256:${"a".repeat(64)}`;
const imageId = `sha256:${"b".repeat(64)}`;

async function setup(directory: string, digests: Record<string, string>) {
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
    stringify({ sandbox: { default_provider: "docker-sbx" } }),
  );
  const cache = join(directory, "cache");
  const platform = process.arch === "arm64" ? "linux/arm64" : "linux/amd64";
  const key = createHash("sha256")
    .update(`example/image:tag\0${digest}\0${platform}`)
    .digest("hex");
  await mkdir(join(cache, "eden", "templates"), { recursive: true });
  await writeFile(
    join(cache, "eden", "templates", `${key}.json`),
    JSON.stringify({
      reference: "example/image:tag",
      digest,
      platform,
      imageId: imageId.slice(7, 19),
      archiveHash: "unused",
    }),
  );
  const snapshots = join(directory, "data", "eden", "sandbox-snapshots", "docker-sbx", "box");
  await mkdir(snapshots, { recursive: true });
  await writeFile(join(snapshots, "20260101T101010123Z.tar.gz"), "archive");

  return {
    cwd: directory,
    env: {
      PATH: pathWith(directory),
      XDG_CONFIG_HOME: config,
      XDG_CACHE_HOME: cache,
      XDG_DATA_HOME: join(directory, "data"),
      XDG_STATE_HOME: join(directory, "state"),
      EDEN_FRESHNESS_LOG: join(directory, "commands"),
      EDEN_FRESHNESS_SANDBOXES: JSON.stringify([
        { name: "box", status: "stopped", workspaces: ["/work/box"] },
      ]),
      EDEN_FRESHNESS_TEMPLATES: JSON.stringify([
        { repository: "docker.io/example/image", tag: "tag", id: imageId.slice(7, 19) },
      ]),
      EDEN_FRESHNESS_INSPECT: JSON.stringify({
        box: { image: "example/image:tag", image_digest: imageId },
      }),
      EDEN_FRESHNESS_DIGESTS: JSON.stringify(digests),
    },
  };
}

test("status reports state, workspace, freshness and the latest snapshot", async () => {
  await withTemporaryDirectory(async (directory) => {
    const options = await setup(directory, { "example/image:tag": digest });

    const result = await runCliWith(options, "sbx", "status", "--name", "box", "--json");

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      sandbox: { name: "box", status: "stopped", workspace: "/work/box" },
      freshness: { state: "current" },
      latestSnapshot: { id: "20260101T101010123Z", sizeBytes: 7 },
    });
  });
});

test("status keeps going with an unknown freshness when the registry fails", async () => {
  await withTemporaryDirectory(async (directory) => {
    const options = await setup(directory, {});

    const result = await runCliWith(options, "sbx", "status", "--name", "box", "--json");

    expect(result.exitCode).toBe(0);
    const data = JSON.parse(result.stdout);
    expect(data.freshness.state).toBe("unknown");
    expect(data.freshness.reason).toContain("registry");
  });
});

test("status skips the registry with --no-check-updates and fails for unknown sandboxes", async () => {
  await withTemporaryDirectory(async (directory) => {
    const options = await setup(directory, { "example/image:tag": digest });

    const skipped = await runCliWith(
      options,
      "sbx",
      "status",
      "--name",
      "box",
      "--no-check-updates",
      "--json",
    );

    expect(JSON.parse(skipped.stdout).freshness).toEqual({
      state: "unknown",
      reason: "Not checked (--no-check-updates).",
    });
    expect(await Bun.file(options.env.EDEN_FRESHNESS_LOG).text()).not.toContain("inspect");

    const human = await runCliWith(options, "sbx", "status", "--name", "box", "--no-check-updates");

    expect(human.stdout).toContain("State:     stopped");
    expect(human.stdout).toContain("Workspace: /work/box");
    expect(human.stdout).toContain("Snapshot:  20260101T101010123Z");

    const missing = await runCliWith(options, "sbx", "status", "--name", "nope", "--json");

    expect(missing.exitCode).toBe(1);
    expect(JSON.parse(missing.stdout).error.code).toBe("SANDBOX_NOT_FOUND");
  });
});
