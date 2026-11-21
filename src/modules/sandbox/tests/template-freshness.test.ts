import { expect, test } from "bun:test";
import { join } from "node:path";
import { createTemporaryDirectory } from "../../fs/tests/support/temporary-directory";
import { installExecutable, pathWith } from "../../fs/tests/support/executable";
import { checkSandboxFreshness } from "../template-freshness";
import type { SandboxProfile } from "../../config/schema";

const image = "exampleacr.azurecr.io/app:latest";

test.each([
  { id: "b".repeat(12), state: "current" },
  { id: `sha256:${"b".repeat(64)}`, state: "current" },
  { id: "c".repeat(12), state: "outdated" },
  { id: "invalid", state: "unknown" },
  { id: "", state: "unknown" },
])("pull never compares the local template ID $id as $state", async ({ id, state }) => {
  await withFakeSbx(async () => {
    process.env.EDEN_FRESHNESS_TEMPLATES = JSON.stringify([
      { repository: "exampleacr.azurecr.io/app", tag: "latest", id },
    ]);
    let lookups = 0;

    const result = await checkSandboxFreshness(
      [{ provider: "docker-sbx", name: "one", status: "stopped", profile: "work" }],
      { work: { template: "another/image:tag", pull: "never" } },
      async () => {
        lookups++;
        throw new Error("Registry access is unavailable");
      },
    );

    expect(result.sandboxes[0]!.freshness.state).toBe(state);
    expect(result.sandboxes[0]!.freshness.reason).toContain(
      state === "unknown" ? "invalid" : "locally loaded template",
    );
    expect(result.warnings).toEqual([]);
    expect(lookups).toBe(0);
  });
});

test.each([
  { kind: "absent template", templates: "[]", state: "missing" },
  { kind: "unavailable templates", failure: "1", state: "unknown" },
  { kind: "malformed templates", templates: "{}", state: "unknown" },
  { kind: "invalid inspection", inspect: "invalid", state: "unknown" },
])("pull never handles $kind without registry access", async (entry) => {
  await withFakeSbx(async () => {
    if (entry.templates) process.env.EDEN_FRESHNESS_TEMPLATES = entry.templates;
    if (entry.failure) process.env.EDEN_FRESHNESS_TEMPLATE_FAILURE = entry.failure;
    if (entry.inspect) process.env.EDEN_FRESHNESS_INSPECT = entry.inspect;
    let lookups = 0;

    const result = await checkSandboxFreshness(
      [{ provider: "docker-sbx", name: "one", status: "stopped", profile: "work" }],
      { work: { pull: "never" } },
      async () => {
        lookups++;
        throw new Error("Unexpected registry access");
      },
    );

    expect(result.sandboxes[0]!.freshness.state).toBe(entry.state);
    expect(lookups).toBe(0);
  });
});

test.each([
  { profile: "work", pull: "always" },
  { profile: "work", pull: "missing" },
  { profile: "work", pull: undefined },
  { profile: "deleted", pull: "never" },
  { profile: undefined, pull: "never" },
] as const)(
  "profile $profile with pull $pull retains registry checks",
  async ({ profile, pull }) => {
    await withFakeSbx(async () => {
      const profiles: Record<string, SandboxProfile> = {
        work: { template: image, pull },
        local: { template: image, pull: "never" },
      };
      let lookups = 0;

      const result = await checkSandboxFreshness(
        [{ provider: "docker-sbx", name: "one", status: "stopped", profile }],
        profiles,
        async () => {
          lookups++;
          throw new Error("denied");
        },
      );

      expect(result.sandboxes[0]!.freshness.state).toBe("unknown");
      expect(lookups).toBe(1);
    });
  },
);

test("local template comparison normalizes Docker Hub references and implicit tags", async () => {
  await withFakeSbx(async () => {
    process.env.EDEN_FRESHNESS_TEMPLATES = JSON.stringify([
      { repository: "docker.io/library/local", tag: "latest", id: "b".repeat(12) },
    ]);
    process.env.EDEN_FRESHNESS_INSPECT = JSON.stringify({
      one: { image: "local", image_digest: `sha256:${"b".repeat(64)}` },
    });

    const result = await checkSandboxFreshness(
      [{ provider: "docker-sbx", name: "one", status: "stopped", profile: "work" }],
      { work: { pull: "never" } },
    );

    expect(result.sandboxes[0]!.freshness.state).toBe("current");
    expect(result.warnings).toEqual([]);
  });
});

async function withFakeSbx(run: () => Promise<void>) {
  await using directory = await createTemporaryDirectory();
  await installExecutable(
    new URL("../../cli/tests/fixtures/sbx-freshness.ts", import.meta.url),
    directory.path,
    "sbx",
  );
  const saved = { ...process.env };
  process.env.PATH = pathWith(directory.path);
  process.env.EDEN_FRESHNESS_LOG = join(directory.path, "commands");
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
