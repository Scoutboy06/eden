import { expect, test } from "bun:test";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createTemporaryDirectory } from "../../../src/modules/fs/tests/support/temporary-directory";
import { listProjectDirectories } from "./project-directories";

test("browses folders at Home, filters partial paths, and opens exact matches", async () => {
  await using fixture = await createTemporaryDirectory();
  const home = fixture.path;
  await mkdir(join(home, "Projects", "Eden workspace", "packages"), { recursive: true });
  await mkdir(join(home, "Projects", "Other"));
  await mkdir(join(home, ".private"));
  await writeFile(join(home, "Projects", "ed-file"), "");

  expect(await listProjectDirectories("", home)).toEqual({
    directory: "~/",
    parent: null,
    prefix: "",
    directories: [{ name: "Projects", path: "~/Projects/" }],
    truncated: false,
  });
  expect(await listProjectDirectories("~/Projects/ed", home)).toMatchObject({
    directory: "~/Projects/",
    parent: "~/",
    prefix: "ed",
    directories: [{ name: "Eden workspace", path: "~/Projects/Eden workspace/" }],
  });
  expect(
    await listProjectDirectories(join(home, "Projects", "Eden workspace"), home),
  ).toMatchObject({
    directory: "~/Projects/Eden workspace/",
    parent: "~/Projects/",
    prefix: "",
    directories: [{ name: "packages", path: "~/Projects/Eden workspace/packages/" }],
  });
  await expect(listProjectDirectories("~/Projects/missing/", home)).rejects.toThrow("not found");
});

test("does not browse hidden folders, paths outside Home, or symlink escapes", async () => {
  await using fixture = await createTemporaryDirectory();
  const home = join(fixture.path, "home");
  const outside = join(fixture.path, "outside");
  await mkdir(join(home, ".private"), { recursive: true });
  await mkdir(outside);
  if (process.platform !== "win32") await symlink(outside, join(home, "linked"));

  expect((await listProjectDirectories("~/", home)).directories).toEqual([]);
  await expect(listProjectDirectories("~/.private/", home)).rejects.toThrow("under Home");
  await expect(listProjectDirectories("~/../outside/", home)).rejects.toThrow("under Home");
  if (process.platform !== "win32") {
    await expect(listProjectDirectories("~/linked/", home)).rejects.toThrow("under Home");
  }
});
