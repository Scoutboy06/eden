import { expect, test } from "bun:test";
import { createTemporaryDirectory } from "../../fs/tests/support/temporary-directory";
import { createSandboxHarness } from "./support/sandbox";

test.each([[[]], [["notion", "db"]]])(
  "passes static MCP names without registration: %j",
  async (servers) => {
    await using directory = await createTemporaryDirectory();
    for (const dryRun of [false, true]) {
      const { service, execution, commands } = await createSandboxHarness({
        directory: directory.path,
        dryRun,
        profile: "work",
        config: {
          sandbox: {
            default_provider: "docker-sbx",
            profiles: { work: { mcp_servers: servers } },
          },
        },
      });

      await service.create({ name: "example" });

      expect(commands.map(({ args }) => args)).toEqual([
        ["ls", "--json"],
        ["policy", "ls", "--json"],
        ...(dryRun
          ? []
          : [
              [
                "create",
                "--name",
                "example",
                ...servers.flatMap((name) => ["--static-mcp", name]),
                "--skills",
                "off",
                "--no-progress",
                "shell",
              ],
            ]),
      ]);
      expect(execution.operations).toHaveLength(1);
      expect(execution.operations[0]?.input).toMatchObject({
        mcpServers: servers,
        profile: "work",
      });
      if (servers.length) {
        expect(execution.operations[0]?.description).toContain("Static MCP servers: notion, db");
      }
    }
  },
);
