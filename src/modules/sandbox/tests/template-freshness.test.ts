import { expect, test } from "bun:test";
import { join } from "node:path";
import { withTemporaryDirectory } from "../../fs/tests/support/temporary-directory";
import { installExecutable, pathWith } from "../../fs/tests/support/executable";
import { checkSandboxFreshness } from "../template-freshness";

const image = "exampleacr.azurecr.io/app:latest";

async function withFakeSbx(run: () => Promise<void>) {
  await withTemporaryDirectory(async (directory) => {
    await installExecutable(
      new URL("../../cli/tests/fixtures/sbx-freshness.ts", import.meta.url),
      directory,
      "sbx",
    );
    const saved = { ...process.env };
    process.env.PATH = pathWith(directory);
    process.env.EDEN_FRESHNESS_LOG = join(directory, "commands");
    process.env.EDEN_FRESHNESS_TEMPLATES = JSON.stringify([
      { repository: "exampleacr.azurecr.io/app", tag: "latest", id: "b".repeat(12) },
    ]);
    process.env.EDEN_FRESHNESS_INSPECT = JSON.stringify({
      one: { image, image_digest: `sha256:${"b".repeat(64)}` },
    });
    try {
      await run();
    } finally {
      process.env = saved;
    }
  });
}

test("the remembered profile selects the registry auth used for the sandbox image", async () => {
  await withFakeSbx(async () => {
    const calls: string[] = [];

    const result = await checkSandboxFreshness(
      [{ provider: "docker-sbx", name: "one", status: "stopped", profile: "work" }],
      { work: { template: image, registry_auth: "docker" } },
      async (reference, auth) => {
        calls.push(`${reference} ${auth}`);
        throw new Error("denied");
      },
    );

    expect(calls).toEqual([`${image} docker`]);
    expect(result.sandboxes[0]!.freshness.state).toBe("unknown");
    expect(result.warnings).toHaveLength(1);
  });
});

test("a failed Azure lookup leaves the sandbox unknown with the reason instead of failing", async () => {
  await withFakeSbx(async () => {
    const result = await checkSandboxFreshness(
      [{ provider: "docker-sbx", name: "one", status: "stopped" }],
      {},
      async () => {
        throw new Error("Azure CLI is not logged in; run az login and retry.");
      },
    );

    expect(result.sandboxes[0]!.freshness).toMatchObject({
      state: "unknown",
      reason: expect.stringContaining("run az login"),
    });
  });
});
