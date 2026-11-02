import { expect, mock, test } from "bun:test";
import { resolveCredential, type CredentialCommand } from "../credentials";
import type { RepositoryRef } from "../provider";

const github: RepositoryRef = { provider: "github", owner: "acme", repository: "app" };
const azure: RepositoryRef = {
  provider: "azure-devops",
  organizationUrl: "https://dev.azure.com/acme",
  project: "Product",
  repository: "app",
};

test("environment credentials win without invoking CLIs", async () => {
  const run = mock<CredentialCommand>(async () => {
    throw new Error("must not run");
  });

  expect(
    await resolveCredential(github, { env: { GH_TOKEN: " first ", GITHUB_TOKEN: "second" }, run }),
  ).toEqual({ kind: "pat", token: "first" });
  expect(
    await resolveCredential(github, { env: { GH_TOKEN: " ", GITHUB_TOKEN: "second" }, run }),
  ).toEqual({ kind: "pat", token: "second" });
  expect(await resolveCredential(azure, { env: { AZURE_DEVOPS_EXT_PAT: "pat" }, run })).toEqual({
    kind: "pat",
    token: "pat",
  });
  expect(run).not.toHaveBeenCalled();
});

test("GitHub CLI fallback is scoped to github.com", async () => {
  const run = mock<CredentialCommand>(async () => ({ exitCode: 0, stdout: "token\n", stderr: "" }));

  expect(await resolveCredential(github, { env: {}, run })).toEqual({
    kind: "pat",
    token: "token",
  });
  expect(run).toHaveBeenCalledWith("gh", ["auth", "token", "--hostname", "github.com"]);
});

test("Azure CLI fallback requests a DevOps bearer token, not a subscription token", async () => {
  const run = mock<CredentialCommand>(async () => ({
    exitCode: 0,
    stdout: JSON.stringify({ accessToken: "entra-token" }),
    stderr: "",
  }));

  expect(await resolveCredential(azure, { env: {}, run })).toEqual({
    kind: "bearer",
    token: "entra-token",
  });
  expect(run.mock.calls[0]?.[1]).toContain("499b84ac-1321-427f-aa17-267ca6975798");
});

test("missing CLI and absent login allow anonymous access", async () => {
  expect(await resolveCredential(github, { env: {}, run: async () => undefined })).toBeUndefined();
  expect(
    await resolveCredential(github, {
      env: {},
      run: async () => ({ exitCode: 1, stdout: "", stderr: "no oauth token found for github.com" }),
    }),
  ).toBeUndefined();
  expect(
    await resolveCredential(azure, {
      env: {},
      run: async () => ({
        exitCode: 1,
        stdout: "",
        stderr: "Please run 'az login' to setup account.",
      }),
    }),
  ).toBeUndefined();
});

test.each([
  { exitCode: 1, stdout: "", stderr: "secret: unexpected internal error" },
  { exitCode: 0, stdout: "", stderr: "" },
])("unexpected credential failures are safe errors, not anonymous fallback", async (result) => {
  await expect(
    resolveCredential(github, { env: {}, run: async () => result }),
  ).rejects.toMatchObject({ code: "SCM_CREDENTIAL_LOOKUP_FAILED" });
  await expect(resolveCredential(github, { env: {}, run: async () => result })).rejects.not.toThrow(
    "secret",
  );
});

test("malformed Azure token responses do not expose stdout", async () => {
  await expect(
    resolveCredential(azure, {
      env: {},
      run: async () => ({ exitCode: 0, stdout: "secret", stderr: "" }),
    }),
  ).rejects.toMatchObject({ code: "SCM_CREDENTIAL_LOOKUP_FAILED" });
});
