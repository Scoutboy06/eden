import { expect, test } from "bun:test";
import { SandboxError } from "../../../modules/sandbox/errors";
import { DockerSandboxProvider } from "../provider";

test.each([
  [
    "array",
    '[{"name":"eden-test","status":"running","id":"provider-id"},{"name":"other","status":"future-provider-status"}]',
    [
      { provider: "docker-sbx", name: "eden-test", status: "running" },
      { provider: "docker-sbx", name: "other", status: "future-provider-status" },
    ],
  ],
  [
    "wrapped",
    '{"sandboxes":[{"name":"two","status":"future"}]}',
    [{ provider: "docker-sbx", name: "two", status: "future" }],
  ],
  ["empty", "[]", []],
] as const)("normalizes Docker listing %s", async (_label, stdout, expected) => {
  const provider = new DockerSandboxProvider(undefined, {
    run: async () => ({ exitCode: 0, stdout, stderr: "" }),
  });

  await expect(provider.list()).resolves.toEqual([...expected]);
});

test.each([
  "invalid-json",
  "null",
  "{}",
  "[null]",
  '[{"name":"example"}]',
  '[{"name":123,"status":"running"}]',
  '[{"name":"example","status":null}]',
])("rejects malformed Docker listing %s", async (stdout) => {
  const calls: string[][] = [];
  const provider = new DockerSandboxProvider(undefined, {
    run: async (args) => {
      calls.push(args);
      return { exitCode: 0, stdout, stderr: "" };
    },
  });

  await expect(provider.list()).rejects.toMatchObject({ code: "SANDBOX_LOOKUP_FAILED" });
  expect(calls).toEqual([["ls", "--json"]]);
});

test.each([
  ["not signed in to Docker", "SANDBOX_AUTH_REQUIRED"],
  ["provider failed unexpectedly", "SANDBOX_PREFLIGHT_FAILED"],
] as const)("normalizes failed Docker listing: %s", async (stderr, code) => {
  const calls: string[][] = [];
  const provider = new DockerSandboxProvider(undefined, {
    run: async (args) => {
      calls.push(args);
      return { exitCode: 1, stdout: "", stderr };
    },
  });

  const error = await provider.list().catch((error: unknown) => error);

  expect(error).toBeInstanceOf(SandboxError);
  expect(error).toMatchObject({ code });
  expect(calls).toEqual([["ls", "--json"]]);
});
