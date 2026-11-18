import { expect, test } from "bun:test";
import { VersionControlChangeType } from "azure-devops-node-api/interfaces/GitInterfaces";
import type { AzureDiffSnapshot } from "../diff";
import { readAzureFileDiff, type AzureItemContentClient } from "../file-diff";

const snapshot: AzureDiffSnapshot = {
  pullRequestId: 7,
  repositoryId: "repo",
  projectId: "project",
  iterationId: 2,
  sourceCommit: "head",
  baseCommit: "base",
  commonCommit: "base",
};

function client(oldText: string | undefined, newText: string | undefined): AzureItemContentClient {
  return {
    getItemContent: async (
      _repository,
      _path,
      _project,
      _scope,
      _recursion,
      _metadata,
      _latest,
      _download,
      version,
    ) => {
      const content = version?.version === snapshot.commonCommit ? oldText : newText;
      return new Blob([content ?? ""]).stream() as unknown as NodeJS.ReadableStream;
    },
  };
}

test("Azure file diff counts and patches added text", async () => {
  const file = await readAzureFileDiff(client(undefined, "one\ntwo\n"), snapshot, {
    changeType: VersionControlChangeType.Add,
    item: { path: "new.txt" },
  });
  expect(file.status).toBe("added");
  expect(file.additions).toBe(2);
  expect(file.deletions).toBe(0);
  expect(file.patch.status).toBe("available");
  if (file.patch.status === "available") expect(file.patch.text).toContain("+two");
});

test("Azure file diff patches modified text", async () => {
  const git = client("old\n", "new\n");
  git.getItemContent = async (
    _repository,
    _path,
    _project,
    _scope,
    _recursion,
    _metadata,
    _latest,
    _download,
    version,
  ) => {
    return new Blob([
      version?.version === "base" ? "old\n" : "new\n",
    ]).stream() as unknown as NodeJS.ReadableStream;
  };
  const file = await readAzureFileDiff(git, snapshot, {
    changeType: VersionControlChangeType.Edit,
    item: { path: "new.txt" },
    sourceServerItem: "old.txt",
  });
  expect(file.additions).toBe(1);
  expect(file.deletions).toBe(1);
});

test("Azure file diff counts deleted text", async () => {
  const file = await readAzureFileDiff(client("gone\n", undefined), snapshot, {
    changeType: VersionControlChangeType.Delete,
    item: { path: "gone.txt" },
  });
  expect(file.status).toBe("deleted");
  expect(file.deletions).toBe(1);
});

test("Azure text hunks preserve context and count content resembling diff headers", async () => {
  const file = await readAzureFileDiff(
    client("before\n---old\nafter\n", "before\n+++new\nafter\n"),
    snapshot,
    {
      changeType: VersionControlChangeType.Edit,
      item: { path: "/nested/file.txt" },
    },
  );

  expect(file).toMatchObject({ path: "nested/file.txt", additions: 1, deletions: 1 });
  expect(file.patch).toMatchObject({
    status: "available",
    text: expect.stringContaining(" before\n----old\n++++new\n after\n"),
  });
});

test("Azure unchanged renames retain both paths with zero line changes", async () => {
  const file = await readAzureFileDiff(client("same\n", "same\n"), snapshot, {
    changeType: VersionControlChangeType.Rename,
    sourceServerItem: "/old.txt",
    item: { path: "/new.txt" },
  });

  expect(file).toEqual({
    path: "new.txt",
    previousPath: "old.txt",
    status: "renamed",
    additions: 0,
    deletions: 0,
    patch: { status: "available", text: "" },
  });
});

test.each([
  ["binary\0content", "binary"],
  ["x".repeat(1_000_001), "too-large"],
] as const)("Azure unavailable content reports its reason %#", async (content, reason) => {
  const file = await readAzureFileDiff(client(undefined, content), snapshot, {
    changeType: VersionControlChangeType.Add,
    item: { path: "data.bin" },
  });

  expect(file.patch).toEqual({ status: "unavailable", reason });
});
