import { expect, test } from "bun:test";
import { withTemporaryDirectory } from "../../fs/tests/support/temporary-directory";
import { createSandboxHarness } from "./support/sandbox";

test("profile creation maps resource settings to Docker arguments and environment", async () => {
  await withTemporaryDirectory(async (directory) => {
    const { service, commands } = await createSandboxHarness({
      directory,
      profile: "work",
      config: {
        sandbox: {
          default_provider: "docker-sbx",
          profiles: { work: { pull: "never", disk: { root: "100g", docker: "50g" } } },
        },
      },
    });

    await service.create({ name: "example" });

    expect(commands.at(-1)).toMatchObject({
      args: [
        "create",
        "--name",
        "example",
        "--pull",
        "never",
        "--skills",
        "off",
        "--no-progress",
        "shell",
      ],
      options: { env: { DOCKER_SANDBOXES_ROOT_SIZE: "100g", DOCKER_SANDBOXES_DOCKER_SIZE: "50g" } },
    });
  });
});

test.each([
  ["provider creation failed", "SANDBOX_CREATE_FAILED", "provider creation failed"],
  ["Sandbox 'example' already exists", "SANDBOX_ALREADY_EXISTS", "Sandbox example already exists"],
] as const)(
  "creation failure is not retried or cleaned up: %s",
  async (diagnostic, code, message) => {
    await withTemporaryDirectory(async (directory) => {
      const { service, commands } = await createSandboxHarness({
        directory,
        run: async (args) =>
          args[0] === "create"
            ? { exitCode: 1, stdout: "", stderr: diagnostic }
            : { exitCode: 0, stdout: "[]", stderr: "" },
      });

      await expect(service.create({ name: "example" })).rejects.toMatchObject({
        code,
        message: expect.stringContaining(message),
      });

      expect(commands.map(({ args }) => args)).toEqual([
        ["ls", "--json"],
        ["policy", "ls", "--json"],
        ["create", "--name", "example", "--skills", "off", "--no-progress", "shell"],
      ]);
    });
  },
);
