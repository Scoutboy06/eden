import { expect, test } from "bun:test";
import { withTemporaryDirectory } from "../../fs/tests/support/temporary-directory";
import { createSandboxHarness } from "./support/sandbox";

test("running a missing sandbox neither records an operation nor creates one", async () => {
  await withTemporaryDirectory(async (directory) => {
    const { service, execution, commands } = await createSandboxHarness({ directory });

    await expect(service.run({ name: "typo" })).rejects.toMatchObject({
      code: "SANDBOX_NOT_FOUND",
    });

    expect(execution.operations).toEqual([]);
    expect(commands.map(({ args }) => args)).toEqual([["ls", "--json"]]);
  });
});

test.each(["", " "])(
  "running an empty sandbox name %j fails before provider calls",
  async (name) => {
    await withTemporaryDirectory(async (directory) => {
      const { service, execution, commands } = await createSandboxHarness({ directory });

      await expect(service.run({ name })).rejects.toMatchObject({
        code: "SANDBOX_INVALID_INPUT",
        message: expect.stringContaining("must not be empty"),
      });

      expect(execution.operations).toEqual([]);
      expect(commands).toEqual([]);
    });
  },
);
