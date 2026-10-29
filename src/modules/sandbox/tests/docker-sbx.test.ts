import { expect, test } from "bun:test";
import { DockerSandboxProvider, type DockerCommandRunner } from "../providers/docker-sbx";

const success = { exitCode: 0, stdout: "[]", stderr: "" };

test("stop passes a literal sandbox name without streaming provider output", async () => {
  const commands: string[][] = [];
  const output: string[] = [];
  const provider = new DockerSandboxProvider((text) => output.push(text), {
    run: async (args, options) => {
      commands.push(args);
      options.onOutput?.("provider output");
      return success;
    },
  });

  await provider.stop("--all; not-a-command");

  expect(commands).toEqual([["stop", "--", "--all; not-a-command"]]);
  expect(output).toEqual([]);
});

test.each([
  ["not signed in to Docker", "SANDBOX_AUTH_REQUIRED"],
  ["unexpected stop failure", "SANDBOX_STOP_FAILED"],
])("stop classifies provider failure: %s", async (diagnostic, code) => {
  const provider = new DockerSandboxProvider(undefined, {
    run: async () => ({ exitCode: 7, stdout: "", stderr: diagnostic }),
  });

  await expect(provider.stop("example")).rejects.toMatchObject({ code });
  if (code === "SANDBOX_STOP_FAILED") {
    await expect(provider.stop("example")).rejects.toThrow(diagnostic);
  }
});

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

test.each([false, true])(
  "creation passes literal kit references and scalar arguments with streaming=%s",
  async (streaming) => {
    const commands: string[][] = [];
    const provider = new DockerSandboxProvider(streaming ? () => {} : undefined, {
      run: async (args) => {
        commands.push(args);

        return success;
      },
    });

    await provider.create({
      name: "example",
      image: "custom:image",
      kits: ["~/missing kit", "C:\\work\\kit", "oci://registry/kit:latest"],
      kitArgs: {
        "team.name": "${sandbox.name}",
        text: "a=b with 'quotes' and $(literal)",
        enabled: true,
        disabled: false,
        count: 3,
        zero: 0,
        negative: -2.5,
        empty: "",
        identifier: "00123",
        ["__proto__"]: "literal",
      },
    });

    expect(commands).toEqual([
      [
        "create",
        "--name",
        "example",
        "--template",
        "custom:image",
        "--kit",
        "~/missing kit",
        "--kit",
        "C:\\work\\kit",
        "--kit",
        "oci://registry/kit:latest",
        "--kit-arg",
        "team.name=${sandbox.name}",
        "--kit-arg",
        "text=a=b with 'quotes' and $(literal)",
        "--kit-arg",
        "enabled=true",
        "--kit-arg",
        "disabled=false",
        "--kit-arg",
        "count=3",
        "--kit-arg",
        "zero=0",
        "--kit-arg",
        "negative=-2.5",
        "--kit-arg",
        "empty=",
        "--kit-arg",
        "identifier=00123",
        "--kit-arg",
        "__proto__=literal",
        "--skills",
        "off",
        ...(streaming ? [] : ["--no-progress"]),
        "shell",
      ],
    ]);
  },
);

test("empty kit collections add no creation flags", async () => {
  const commands: string[][] = [];
  const provider = new DockerSandboxProvider(undefined, {
    run: async (args) => {
      commands.push(args);

      return success;
    },
  });

  await provider.create({ name: "example", kits: [], kitArgs: {} });

  expect(commands).toEqual([
    ["create", "--name", "example", "--skills", "off", "--no-progress", "shell"],
  ]);
});

test("kit validation errors are delegated to Docker and preserve its diagnostic", async () => {
  const provider = new DockerSandboxProvider(undefined, {
    run: async () => ({ exitCode: 1, stdout: "", stderr: "kit reference not found: missing-kit" }),
  });

  await expect(provider.create({ name: "example", kits: ["missing-kit"] })).rejects.toMatchObject({
    code: "SANDBOX_CREATE_FAILED",
    message: expect.stringContaining("kit reference not found: missing-kit"),
  });
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
