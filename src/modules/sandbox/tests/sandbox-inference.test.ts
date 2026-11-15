import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createTemporaryDirectory } from "../../fs/tests/support/temporary-directory";
import type { SandboxSummary } from "../provider";
import { inferSandbox } from "../sandbox-inference";

function summary(name: string, workspace?: string): SandboxSummary {
  return { provider: "docker-sbx", name, status: "running", ...(workspace ? { workspace } : {}) };
}

async function withCheckout<T>(action: (checkout: string) => Promise<T>) {
  await using directory = await createTemporaryDirectory();
  const checkout = join(directory.path, "My Project");
  await mkdir(checkout);

  return await action(checkout);
}

test("prefers the sandbox whose workspace is the checkout", async () => {
  await withCheckout(async (checkout) => {
    const sandboxes = [summary("my-project"), summary("other", `${checkout}/`)];

    expect(await inferSandbox(sandboxes, checkout, "docker-sbx")).toEqual({
      name: "other",
      source: "workspace",
      checkout,
    });
  });
});

test("ignores the read-only suffix on a workspace", async () => {
  await withCheckout(async (checkout) => {
    const result = await inferSandbox([summary("one", `${checkout}:ro`)], checkout, "docker-sbx");

    expect(result.name).toBe("one");
  });
});

test.skipIf(process.platform !== "win32")(
  "matches Windows workspaces by case and separators",
  async () => {
    await withCheckout(async (checkout) => {
      const alternate = checkout.toUpperCase().replaceAll("\\", "/");
      const result = await inferSandbox([summary("one", alternate)], checkout, "docker-sbx");

      expect(result.name).toBe("one");
    });
  },
);

test("falls back to the derived name when no workspace matches", async () => {
  await withCheckout(async (checkout) => {
    const sandboxes = [summary("my-project"), summary("other", join(checkout, "elsewhere"))];

    expect(await inferSandbox(sandboxes, checkout, "docker-sbx")).toEqual({
      name: "my-project",
      source: "folder",
      checkout,
    });
  });
});

test("does not fall back to a same-named sandbox that belongs to another workspace", async () => {
  await withCheckout(async (checkout) => {
    const sandboxes = [summary("my-project", join(checkout, "elsewhere"))];

    await expect(inferSandbox(sandboxes, checkout, "docker-sbx")).rejects.toThrow(
      "No sandbox found",
    );
  });
});

test("reports every sandbox when several use the checkout", async () => {
  await withCheckout(async (checkout) => {
    const sandboxes = [summary("a", checkout), summary("b", checkout), summary("c")];

    await expect(inferSandbox(sandboxes, checkout, "docker-sbx")).rejects.toThrow(
      /Several docker-sbx sandboxes.*: a, b\. Pass --name/,
    );
  });
});

test("names the checkout and derived name when nothing matches", async () => {
  await withCheckout(async (checkout) => {
    await expect(inferSandbox([summary("other")], checkout, "docker-sbx")).rejects.toThrow(
      /No sandbox found.*my-project.*--name/,
    );
  });
});
