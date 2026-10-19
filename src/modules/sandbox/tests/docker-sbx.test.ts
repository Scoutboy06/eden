import { expect, test } from "bun:test";
import { DockerSandboxProvider, type DockerCommandRunner } from "../providers/docker-sbx";

const success = { exitCode: 0, stdout: "[]", stderr: "" };

test("provider construction runs no checks", () => {
  let calls = 0;

  new DockerSandboxProvider(undefined, {
    isInstalled: () => {
      calls++;
      return true;
    },
    run: async () => {
      calls++;
      return success;
    },
  });

  expect(calls).toBe(0);
});

test.each([
  ["not signed in to Docker", "SANDBOX_AUTH_REQUIRED"],
  ["global network policy has not been initialized", "SANDBOX_NETWORK_POLICY_REQUIRED"],
  ["sandbox 'existing' already exists; connect to the existing sandbox", "SANDBOX_ALREADY_EXISTS"],
  ["unexpected provider failure", "SANDBOX_CREATE_FAILED"],
] as const)("creation classifies captured diagnostic: %s", async (diagnostic, code) => {
  const provider = new DockerSandboxProvider(undefined, {
    run: async () => ({ exitCode: 1, stdout: "", stderr: diagnostic }),
  });

  await expect(provider.create({ name: "existing" })).rejects.toMatchObject({ code });
});

test("unknown failures preserve provider diagnostics", async () => {
  const provider = new DockerSandboxProvider(undefined, {
    run: async () => ({ exitCode: 2, stdout: "provider stdout", stderr: "provider stderr" }),
  });

  await expect(provider.create({ name: "new" })).rejects.toThrow(
    "provider stdout\nprovider stderr",
  );
});

test("creation passes separate arguments and delegates an omitted image", async () => {
  const commands: string[][] = [];
  const run: DockerCommandRunner = async (args) => {
    commands.push(args);
    return success;
  };
  const provider = new DockerSandboxProvider(undefined, { run });

  await provider.create({ name: "test; not-a-command" });
  await provider.create({ name: "test", image: "custom/image:tag" });

  expect(commands).toEqual([
    ["create", "--name", "test; not-a-command", "--skills", "off", "--no-progress", "shell"],
    [
      "create",
      "--name",
      "test",
      "--template",
      "custom/image:tag",
      "--skills",
      "off",
      "--no-progress",
      "shell",
    ],
  ]);
});

test("readiness checks use injected commands and recognize authentication and policy setup", async () => {
  const signal = new AbortController().signal;
  const commands: string[][] = [];
  const provider = new DockerSandboxProvider(undefined, {
    isInstalled: () => true,
    run: async (args) => {
      commands.push(args);
      return {
        exitCode: 1,
        stdout: "",
        stderr:
          args[0] === "ls"
            ? "not signed in to Docker"
            : "global network policy has not been initialized",
      };
    },
  });
  const [installation, login, policy] = provider.readinessChecks();

  expect(await installation!.run(signal)).toMatchObject({ state: "ready", label: "Installed" });
  expect(await login!.run(signal)).toMatchObject({
    state: "missing",
    label: "Sign-in required",
    instructions: ["Sign in with:", "  sbx login"],
  });
  expect(await policy!.run(signal)).toMatchObject({ state: "missing", label: "Policy required" });
  expect(commands).toEqual([
    ["ls", "--format", "json"],
    ["policy", "ls", "--json"],
  ]);
});

test("missing tools and failed checks remain informational", async () => {
  const signal = new AbortController().signal;
  const provider = new DockerSandboxProvider(undefined, {
    isInstalled: () => false,
    run: async () => {
      throw new Error("Provider unavailable");
    },
  });
  const checks = provider.readinessChecks();

  expect(await checks[0]!.run(signal)).toMatchObject({ state: "missing", label: "Not installed" });
  expect(await checks[1]!.run(signal)).toMatchObject({ state: "unknown", label: "Login unknown" });
});

test("policy lookup requiring login is skipped rather than reported as missing policy", async () => {
  const provider = new DockerSandboxProvider(undefined, {
    run: async () => ({ exitCode: 1, stdout: "", stderr: "not signed in to Docker" }),
  });

  expect(await provider.readinessChecks()[2]!.run(new AbortController().signal)).toEqual({
    state: "skipped",
    label: "Policy not checked",
  });
});

test("readiness forwards cancellation to its command runner", async () => {
  const controller = new AbortController();
  let signal: AbortSignal | undefined;
  const provider = new DockerSandboxProvider(undefined, {
    run: async (_args, options) => {
      signal = options.signal;
      return success;
    },
  });

  await provider.readinessChecks()[1]!.run(controller.signal);
  controller.abort();

  expect(signal).toBe(controller.signal);
  expect(signal?.aborted).toBe(true);
});
