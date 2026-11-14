import { expect, test } from "bun:test";
import { join } from "node:path";
import { homedir } from "node:os";
import { createExecution } from "../../execution";
import { SandboxService } from "../sandbox.service";
import type { SandboxProvider } from "../provider";

test.each([
  ["running", false, true],
  ["stopped", false, false],
  ["running", true, false],
  ["stopped", true, false],
] as const)("stop handles status=%s, dryRun=%s", async (status, dryRun, shouldStop) => {
  const execution = createExecution({ dryRun });
  const calls: string[] = [];
  const provider: SandboxProvider = {
    name: "docker-sbx",
    readinessChecks: () => [],
    preflight: async () => {
      throw new Error("Stop must not check creation prerequisites");
    },
    list: async () => [{ provider: "docker-sbx", name: "example", status }],
    run: async () => {
      throw new Error("Stop must not attach");
    },
    create: async () => {
      throw new Error("Stop must not create");
    },
    stop: async (name) => {
      calls.push(name);
    },
  };

  await new SandboxService(execution, provider).stop("example");

  const expectedCalls = shouldStop ? ["example"] : [];
  expect(calls).toEqual(expectedCalls);
  expect(execution.operations).toEqual([
    {
      type: "sandbox.stop",
      description: "Stop sandbox example using docker-sbx",
      input: { provider: "docker-sbx", name: "example" },
    },
  ]);
});

test.each([false, true])("run never creates a missing sandbox, dryRun=%s", async (dryRun) => {
  const execution = createExecution({ dryRun });
  const calls: string[] = [];
  const provider: SandboxProvider = {
    name: "docker-sbx",
    readinessChecks: () => [],
    preflight: async () => {
      calls.push("preflight");
    },
    list: async () => {
      calls.push("list");
      return [];
    },
    run: async () => {
      calls.push("run");
      return 0;
    },
    stop: async () => {
      calls.push("stop");
    },
    create: async () => {
      calls.push("create");
    },
  };
  const service = new SandboxService(execution, provider, {
    name: "work",
    template: "profile:image",
  });

  await expect(service.run({ name: "typo" })).rejects.toMatchObject({ code: "SANDBOX_NOT_FOUND" });

  expect(calls).toEqual(["list"]);
  expect(execution.operations).toEqual([]);
});

test.each([
  ["running", false],
  ["stopped", false],
  ["running", true],
  ["stopped", true],
] as const)("run only attaches to an existing %s sandbox, dryRun=%s", async (status, dryRun) => {
  const execution = createExecution({ dryRun });
  const calls: string[] = [];
  const provider: SandboxProvider = {
    name: "docker-sbx",
    readinessChecks: () => [],
    preflight: async () => {
      calls.push("preflight");
    },
    list: async () => [{ provider: "docker-sbx", name: "example", status }],
    run: async (name) => {
      calls.push(name);
      return 7;
    },
    stop: async () => {
      calls.push("stop");
    },
    create: async () => {
      calls.push("create");
    },
  };
  const service = new SandboxService(execution, provider);

  const exitCode = await service.run({ name: "example" });

  const expectedExitCode = dryRun ? 0 : 7;
  const expectedCalls = dryRun ? [] : ["example"];
  expect(exitCode).toBe(expectedExitCode);
  expect(calls).toEqual(expectedCalls);
  expect(execution.operations.map(({ type }) => type)).toEqual(["sandbox.run"]);
});

test("dry-run checks prerequisites but never calls creation", async () => {
  const execution = createExecution({ dryRun: true });
  const calls: string[] = [];
  const provider: SandboxProvider = {
    name: "docker-sbx",
    readinessChecks: () => [],
    preflight: async () => {
      calls.push("preflight");
    },
    list: async () => [],
    run: async () => 0,
    stop: async () => {},
    create: async () => {
      calls.push("create");
    },
  };

  await new SandboxService(execution, provider).create({ name: "example" });

  expect(calls).toEqual(["preflight"]);
  expect(execution.operations).toHaveLength(1);
});

test.each([false, true])(
  "profile kit values stay typed at the service boundary with dryRun=%s",
  async (dryRun) => {
    const execution = createExecution({ dryRun });
    const calls: unknown[] = [];
    const kits = ["~/literal kit"];
    const kitArgs = { enabled: true, count: 3, name: "${sandbox.name}" };
    const provider: SandboxProvider = {
      name: "docker-sbx",
      readinessChecks: () => [],
      preflight: async () => {},
      list: async () => [],
      run: async () => 0,
      stop: async () => {},
      create: async (input) => {
        calls.push(input);
      },
    };
    const service = new SandboxService(execution, provider, {
      name: "work",
      kits,
      kit_args: kitArgs,
    });

    await service.create({ name: "example" });

    const resolvedKits = [join(homedir(), "literal kit")];
    const expectedCalls = dryRun
      ? []
      : [{ name: "example", image: undefined, kits: resolvedKits, kitArgs }];
    expect(calls).toEqual(expectedCalls);
    expect(execution.operations[0]?.input).toEqual({
      provider: "docker-sbx",
      name: "example",
      image: undefined,
      profile: "work",
      kits: resolvedKits,
      kitArgs,
    });
  },
);

test.each([false, true])(
  "exec passes exact input through mutation boundary, dryRun=%s",
  async (dryRun) => {
    const execution = createExecution({ dryRun });
    const calls: unknown[] = [];
    const provider: SandboxProvider = {
      name: "docker-sbx",
      readinessChecks: () => [],
      preflight: async () => {},
      list: async () => [{ provider: "docker-sbx", name: "example", status: "stopped" }],
      run: async () => 0,
      stop: async () => {},
      create: async () => {
        throw new Error("must not create");
      },
      exec: async (input) => {
        calls.push(input);
        return { exitCode: 7, stdout: "out", stderr: "err" };
      },
    };
    const input = { name: "example", argv: ["echo", "a b", "--"], output: "capture" } as const;
    const result = await new SandboxService(execution, provider).exec({
      ...input,
      argv: [...input.argv],
    });
    const expectedResult = dryRun ? undefined : { exitCode: 7, stdout: "out", stderr: "err" };
    const expectedCalls = dryRun ? [] : [input];
    expect(result).toEqual(expectedResult);
    expect(calls).toEqual(expectedCalls);
    expect(execution.operations).toMatchObject([
      { type: "sandbox.exec", input: { argv: input.argv } },
    ]);
  },
);
