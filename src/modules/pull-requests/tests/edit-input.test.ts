import { expect, test } from "bun:test";
import { join } from "node:path";
import { createTemporaryDirectory } from "../../fs/tests/support/temporary-directory";
import { buildPullRequestPatch } from "../edit-input";

test("edit options preserve omitted fields, empty bodies and ready state", async () => {
  expect(await buildPullRequestPatch({})).toEqual({});
  expect(await buildPullRequestPatch({ body: "", ready: true })).toEqual({
    body: "",
    isDraft: false,
  });
  expect(
    await buildPullRequestPatch({ title: "Title", targetBranch: "release", draft: true }),
  ).toEqual({
    title: "Title",
    targetBranch: "release",
    isDraft: true,
  });
});

test("edit rejects conflicting body and draft options before trying to read a file", async () => {
  await expect(buildPullRequestPatch({ body: "", bodyFile: "missing" })).rejects.toMatchObject({
    code: "SCM_INVALID_OPTIONS",
  });
  await expect(
    buildPullRequestPatch({ draft: true, ready: true, bodyFile: "missing" }),
  ).rejects.toMatchObject({ code: "SCM_INVALID_OPTIONS" });
});

test("edit reads UTF-8 body files exactly, including an empty file", async () => {
  await using directory = await createTemporaryDirectory();
  const path = join(directory.path, "body.md");
  const body = "Å description\n\nKeep trailing whitespace.  \n";
  await Bun.write(path, body);

  expect(await buildPullRequestPatch({ bodyFile: path })).toEqual({ body });

  await Bun.write(path, "");

  expect(await buildPullRequestPatch({ bodyFile: path })).toEqual({ body: "" });
  await expect(
    buildPullRequestPatch({ bodyFile: join(directory.path, "absent") }),
  ).rejects.toMatchObject({ code: "SCM_BODY_FILE_FAILED" });
});
