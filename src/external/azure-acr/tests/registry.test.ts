import { expect, test } from "bun:test";
import {
  azureCliFailure,
  azureManifestDigest,
  isAzureRegistryHost,
  parseAzureImageReference,
} from "../registry";

const digest = `sha256:${"a".repeat(64)}`;
const image = parseAzureImageReference("exampleacr.azurecr.io/team/app:stable");

function fakeRegistry(options: { exchange?: number; manifest?: number } = {}) {
  const calls: Array<{ url: string; method?: string; body?: string; headers?: unknown }> = [];
  const fakeFetch = (async (url: string, init?: RequestInit) => {
    calls.push({
      url,
      method: init?.method,
      body: init?.body?.toString(),
      headers: init?.headers,
    });
    if (url.endsWith("/oauth2/token"))
      return new Response(JSON.stringify({ access_token: "bearer-1" }), {
        status: options.exchange ?? 200,
      });

    return new Response(null, {
      status: options.manifest ?? 200,
      headers: { "docker-content-digest": digest },
    });
  }) as unknown as typeof fetch;

  return { calls, fakeFetch };
}

const runAz = async () => JSON.stringify({ accessToken: "refresh-1", loginServer: "x" });

test("detects Azure registry hosts and parses references", () => {
  expect(isAzureRegistryHost("exampleacr.azurecr.io")).toBe(true);
  expect(isAzureRegistryHost("docker.io")).toBe(false);
  expect(isAzureRegistryHost("azurecr.io.evil.com")).toBe(false);
  expect(image).toEqual({ host: "exampleacr.azurecr.io", repository: "team/app", tag: "stable" });
  expect(parseAzureImageReference("exampleacr.azurecr.io/app").tag).toBe("latest");
});

test("exchanges the az token for a pull-scoped bearer token and reads the manifest digest", async () => {
  const azCalls: string[][] = [];
  const { calls, fakeFetch } = fakeRegistry();

  const result = await azureManifestDigest(image, {
    runAz: async (args) => {
      azCalls.push(args);

      return runAz();
    },
    fetch: fakeFetch,
  });

  expect(result).toBe(digest);
  expect(azCalls[0]).toContain("--expose-token");
  expect(azCalls[0]).toContain("exampleacr");
  expect(calls[0]!.body).toContain("refresh_token=refresh-1");
  expect(calls[0]!.body).toContain("scope=repository%3Ateam%2Fapp%3Apull");
  expect(calls[1]).toMatchObject({
    url: "https://exampleacr.azurecr.io/v2/team/app/manifests/stable",
    method: "HEAD",
  });
  expect(JSON.stringify(calls[1]!.headers)).toContain('"Bearer bearer-1"');
});

test("reports registry rejections and unusable az output", async () => {
  await expect(
    azureManifestDigest(image, { runAz, fetch: fakeRegistry({ exchange: 401 }).fakeFetch }),
  ).rejects.toThrow("rejected the Azure token (401)");
  await expect(
    azureManifestDigest(image, { runAz, fetch: fakeRegistry({ manifest: 404 }).fakeFetch }),
  ).rejects.toThrow("returned 404");
  await expect(
    azureManifestDigest(image, { runAz: async () => "not json", fetch: fakeRegistry().fakeFetch }),
  ).rejects.toThrow("did not return a registry access token");
});

test("az failures tell the user to log in when credentials are missing", () => {
  expect(azureCliFailure("ERROR: Please run 'az login' to setup account.").message).toContain(
    "run az login",
  );
  expect(azureCliFailure("ERROR: registry not found").message).toContain("registry not found");
});
