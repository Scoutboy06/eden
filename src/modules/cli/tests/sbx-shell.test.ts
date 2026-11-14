import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stringify } from "yaml";
import { withTemporaryDirectory } from "../../fs/tests/support/temporary-directory";
import { runCliWith } from "./support/cli";
import { prepareSandboxCli, sandboxCommands } from "./support/sandbox";

async function providerCommands(directory: string) {
  return (await sandboxCommands(directory)).filter((command) => command[0] !== "ls");
}

test("shell opens a login shell in a running sandbox and passes through the exit status", async () => {
  await withTemporaryDirectory(async (directory) => {
    const options = await prepareSandboxCli(directory, "failure");

    const result = await runCliWith(options, "sbx", "shell", "--name", "example");

    expect(result.exitCode).toBe(7);
    expect(await providerCommands(directory)).toEqual([
      ["exec", "-i", "--", "example", "bash", "-l"],
    ]);
  });
});

test("shell starts a stopped sandbox before opening the shell in the given folder", async () => {
  await withTemporaryDirectory(async (directory) => {
    const options = await prepareSandboxCli(directory, "stopped");

    const result = await runCliWith(
      options,
      "sbx",
      "shell",
      "--name",
      "example",
      "--cwd",
      "/home/agent",
    );

    expect(result.exitCode).toBe(0);
    expect(await providerCommands(directory)).toEqual([
      ["run", "--detach", "--name", "example"],
      ["exec", "-i", "-w", "/home/agent", "--", "example", "bash", "-l"],
    ]);
  });
});

test("shell uses the shell settings of the profile that created the sandbox", async () => {
  await withTemporaryDirectory(async (directory) => {
    const options = await prepareSandboxCli(directory, "running");
    await writeFile(
      join(options.env.XDG_CONFIG_HOME!, "eden", "config.yaml"),
      stringify({
        sandbox: {
          default_provider: "docker-sbx",
          profiles: {
            work: {
              agent: "claude",
              pull: "never",
              shell: { cwd: "/work", command: ["zsh", "-l"] },
            },
          },
        },
      }),
    );
    options.env.EDEN_SBX_AGENT = "claude";
    options.env.EDEN_SBX_PULL = "never";
    await runCliWith(options, "sbx", "create", "--name", "example", "--profile", "work");

    const result = await runCliWith(options, "sbx", "shell", "--name", "example");

    expect(result.exitCode).toBe(0);
    expect((await providerCommands(directory)).at(-1)).toEqual([
      "exec",
      "-i",
      "-w",
      "/work",
      "--",
      "example",
      "zsh",
      "-l",
    ]);
  });
});

test("shell rejects JSON output without contacting the provider", async () => {
  await withTemporaryDirectory(async (directory) => {
    const options = await prepareSandboxCli(directory, "running");

    const result = await runCliWith(options, "sbx", "shell", "--name", "example", "--json");

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).error.code).toBe("SANDBOX_INVALID_INPUT");
    await expect(sandboxCommands(directory)).rejects.toThrow();
  });
});
