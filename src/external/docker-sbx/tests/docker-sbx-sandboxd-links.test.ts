import { expect, test } from "bun:test";
import { DockerSandboxProvider } from "../provider";
import type { SandboxdLinkProbe } from "../sandboxd-links";

const recordedLog = await Bun.file(new URL("fixtures/sandboxd-daemon.log", import.meta.url)).text();
const localAppData = String.raw`C:\Users\example\AppData\Local`;
const temp = String.raw`C:\Users\example\AppData\Local\Temp\1`;
const link = String.raw`C:\Users\example\AppData\Local\Temp\sboxd-fafa863a`;
const stateDir = String.raw`C:\Users\example\AppData\Local\DockerSandboxes\sandboxes\state\sandboxd`;
const failure = {
  exitCode: 1,
  stdout: "",
  stderr: "500 Internal Server Error: failed to start runtime",
};

function probe(overrides: Partial<SandboxdLinkProbe> = {}): SandboxdLinkProbe {
  return {
    platform: "win32",
    env: { LOCALAPPDATA: localAppData, TEMP: temp },
    readText: (path) => (path === `${stateDir}\\daemon.log` ? recordedLog : undefined),
    exists: () => false,
    ...overrides,
  };
}

function providerWith(sandboxdLinkProbe: SandboxdLinkProbe) {
  return new DockerSandboxProvider(undefined, {
    run: async () => failure,
    sandboxdLinkProbe,
  });
}

test("start explains a missing sandboxd temp link", async () => {
  const error = await providerWith(probe())
    .start("example")
    .catch((caught: unknown) => caught);

  expect(error).toMatchObject({ code: "SANDBOX_START_LINK_MISSING" });
  expect((error as Error).message).toBe(
    [
      "Docker Sandboxes could not start sandbox example (exit 1) because sandboxd's temp link is missing. No retry or cleanup was attempted.",
      "",
      "Missing link:",
      `  ${link}`,
      "",
      `Current TEMP: ${temp}`,
      `It should point to: ${stateDir}`,
      "",
      "Recreate it in PowerShell:",
      `  New-Item -ItemType Junction -Path "${link}" -Target "${stateDir}"`,
      "",
      "Docker Sandboxes reported:",
      "500 Internal Server Error: failed to start runtime",
    ].join("\n"),
  );
});

test("start keeps the generic failure when the link exists again", async () => {
  const provider = providerWith(probe({ exists: (path) => path === link }));

  await expect(provider.start("example")).rejects.toMatchObject({
    code: "SANDBOX_START_FAILED",
  });
});

test("start keeps the generic failure when daemon.log is unreadable", async () => {
  const provider = providerWith(probe({ readText: () => undefined }));

  await expect(provider.start("example")).rejects.toMatchObject({
    code: "SANDBOX_START_FAILED",
  });
});

test("start keeps the generic failure off Windows", async () => {
  const provider = providerWith(probe({ platform: "linux" }));

  await expect(provider.start("example")).rejects.toMatchObject({
    code: "SANDBOX_START_FAILED",
  });
});

test("stop failures ignore the daemon log", async () => {
  const provider = providerWith(probe());

  await expect(provider.stop("example")).rejects.toMatchObject({
    code: "SANDBOX_STOP_FAILED",
  });
});
