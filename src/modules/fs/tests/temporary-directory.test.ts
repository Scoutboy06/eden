import { expect, test } from "bun:test";
import { stat } from "node:fs/promises";
import { createTemporaryDirectory } from "./support/temporary-directory";

test("removes the temporary directory when its scope exits", async () => {
  let path = "";

  {
    await using directory = await createTemporaryDirectory();
    path = directory.path;
    expect((await stat(path)).isDirectory()).toBe(true);
  }

  await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
});

test("removes the temporary directory when its scope throws", async () => {
  let path = "";
  const error = new Error("scope failed");

  await expect(
    (async () => {
      await using directory = await createTemporaryDirectory();
      path = directory.path;
      throw error;
    })(),
  ).rejects.toBe(error);

  await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
});
