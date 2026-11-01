import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stringify } from "yaml";
import { withTemporaryDirectory } from "../../fs/tests/support/temporary-directory";
import { runCliWith } from "./support/cli";
import { prepareSandboxCli, sandboxCommands } from "./support/sandbox";

test.each([[[]], [["notion", "db"]]])(
  "passes static MCP names without registration: %j",
  async (servers) => {
    await withTemporaryDirectory(async (directory) => {
      const options = await prepareSandboxCli(directory, "missing");
      options.env.EDEN_SBX_MCP_FLAGS = JSON.stringify(
        servers.flatMap((name) => ["--static-mcp", name]),
      );
      await writeFile(
        join(options.env.XDG_CONFIG_HOME!, "eden", "config.yaml"),
        stringify({
          sandbox: { default_provider: "docker-sbx", profiles: { work: { mcp_servers: servers } } },
        }),
      );

      const result = await runCliWith(
        options,
        "sbx",
        "create",
        "--name",
        "example",
        "--profile",
        "work",
      );
      const preview = await runCliWith(
        options,
        "sbx",
        "create",
        "--name",
        "example",
        "--profile",
        "work",
        "--dry-run",
        "--json",
      );
      const human = await runCliWith(
        options,
        "sbx",
        "create",
        "--name",
        "example",
        "--profile",
        "work",
        "--dry-run",
      );

      expect(result.exitCode).toBe(0);
      expect((await sandboxCommands(directory))[2]).toEqual([
        "create",
        "--name",
        "example",
        ...servers.flatMap((name) => ["--static-mcp", name]),
        "--skills",
        "off",
        "shell",
      ]);
      expect(JSON.parse(preview.stdout).operations[0].input.mcpServers).toEqual(servers);
      if (servers.length) expect(human.stdout).toContain("Static MCP servers: notion, db");
    });
  },
);
