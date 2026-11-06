import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createExecution } from "../../execution";
import { GitModule } from "../git.module";
import { GitService } from "../git.service";

describe("GitService", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "eden-git-service-"));
    await GitModule.execute(directory, ["init", "-b", "main"]);
    await GitModule.execute(directory, ["config", "user.name", "Eden Test"]);
    await GitModule.execute(directory, ["config", "user.email", "eden@example.test"]);
    await writeFile(join(directory, "file"), "initial\n");
    await GitModule.execute(directory, ["add", "."]);
    await GitModule.execute(directory, [
      "commit",
      "--cleanup=verbatim",
      "-m",
      "initial",
      "-m",
      "body",
    ]);
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  test("records dry-run mutations without changing Git state", async () => {
    const execution = createExecution({ dryRun: true });
    const service = new GitService(execution);
    await service.createBranch({ name: "topic" }, directory);

    expect(execution.operations).toHaveLength(1);
    expect(await GitModule.localBranches(directory)).toHaveLength(1);
  });

  test("validates branch inputs before recording dry-run mutations", async () => {
    const execution = createExecution({ dryRun: true });
    const service = new GitService(execution);
    await expect(service.createBranch({ name: "--delete" }, directory)).rejects.toThrow();
    await expect(
      service.renameBranch({ name: "missing", newName: "valid" }, directory),
    ).rejects.toThrow("Local branch not found");
    await expect(service.deleteBranch({ name: "missing" }, directory)).rejects.toThrow(
      "Local branch not found",
    );
    await expect(
      service.publishBranch({ name: "missing", remote: "origin" }, directory),
    ).rejects.toThrow("Local branch not found");
    await expect(service.fetch({ remote: "--upload-pack=bad" }, directory)).rejects.toThrow(
      "Invalid remote name",
    );

    expect(execution.operations).toHaveLength(0);
    expect((await GitModule.localBranches(directory)).map((branch) => branch.name)).toEqual([
      "main",
    ]);
  });

  test("preflights branch collisions and deletion safety in dry-run and real modes", async () => {
    await GitModule.execute(directory, ["branch", "topic"]);
    const linkedPath = join(directory, "linked-topic");
    await GitModule.execute(directory, ["worktree", "add", "--", linkedPath, "topic"]);

    for (const dryRun of [true, false]) {
      const execution = createExecution({ dryRun });
      const service = new GitService(execution);
      await expect(service.createBranch({ name: "main" }, directory)).rejects.toThrow(
        "Local branch already exists",
      );
      await expect(
        service.renameBranch({ name: "topic", newName: "main" }, directory),
      ).rejects.toThrow("Local branch already exists");
      await expect(service.deleteBranch({ name: "main", force: true }, directory)).rejects.toThrow(
        "checked out in a worktree",
      );
      await expect(service.deleteBranch({ name: "topic", force: true }, directory)).rejects.toThrow(
        "checked out in a worktree",
      );
      expect(execution.operations).toHaveLength(0);
    }

    await GitModule.execute(linkedPath, ["checkout", "--detach"]);
    await writeFile(join(directory, "new-file"), "unmerged\n");
    await GitModule.execute(directory, ["checkout", "-b", "unmerged"]);
    await GitModule.execute(directory, ["add", "."]);
    await GitModule.execute(directory, ["commit", "-m", "unmerged"]);
    await GitModule.execute(directory, ["checkout", "main"]);

    for (const dryRun of [true, false]) {
      const execution = createExecution({ dryRun });
      const service = new GitService(execution);
      await expect(service.deleteBranch({ name: "unmerged" }, directory)).rejects.toThrow(
        "not fully merged",
      );
      expect(execution.operations).toHaveLength(0);
    }

    const service = new GitService(createExecution({ dryRun: true }));
    await service.deleteBranch({ name: "unmerged", force: true }, directory);
    expect((await GitModule.localBranches(directory)).map((branch) => branch.name)).toContain(
      "unmerged",
    );
  });

  test("uses local branch identity and returns structured bounded history", async () => {
    await GitModule.execute(directory, ["tag", "topic"]);
    const service = new GitService(createExecution({ dryRun: false }));
    await service.createBranch({ name: "topic" }, directory);
    expect((await service.showBranch("topic", directory)).name).toBe("topic");
    await service.renameBranch({ name: "refs/heads/topic", newName: "renamed" }, directory);
    expect((await GitModule.localBranches(directory)).map((branch) => branch.name)).toContain(
      "renamed",
    );
    const history = await service.commitHistory({ ref: "main", limit: 1 }, directory);
    expect(history).toEqual([
      expect.objectContaining({ subject: "initial", body: "body\n", parents: [] }),
    ]);
    await service.deleteBranch({ name: "renamed" }, directory);
  });

  test("frames multi-commit history losslessly and accepts commit IDs", async () => {
    const messages = [
      { subject: "third  ", body: "  leading\ninterior\n\ntrailing  \n" },
      { subject: "second", body: "line one\nline two" },
    ];
    const ids = [await GitModule.resolveCommit(directory)];
    for (const message of messages) {
      await writeFile(join(directory, "file"), `${message.subject}\n`);
      await GitModule.execute(directory, ["add", "."]);
      await GitModule.execute(directory, [
        "commit",
        "--cleanup=verbatim",
        "-m",
        message.subject,
        "-m",
        message.body,
      ]);
      ids.push(await GitModule.resolveCommit(directory));
    }

    const service = new GitService(createExecution({ dryRun: false }));
    const history = await service.commitHistory({ ref: "main", limit: 3 }, directory);
    expect(history.map((commit) => commit.hash)).toEqual([...ids].reverse());
    expect(history.map(({ subject, body }) => ({ subject, body }))).toEqual([
      { subject: "second", body: "line one\nline two\n" },
      { subject: "third  ", body: "  leading\ninterior\n\ntrailing  \n" },
      { subject: "initial", body: "body\n" },
    ]);

    await service.createBranch({ name: "from-id", startPoint: ids[1]! }, directory);
    expect((await service.showBranch("from-id", directory)).commit).toBe(ids[1]!);
    expect((await service.commitHistory({ ref: ids[1], limit: 1 }, directory))[0]?.hash).toBe(
      ids[1]!,
    );
  });

  test("rejects option-like and non-local refs", async () => {
    const service = new GitService(createExecution({ dryRun: false }));
    await expect(service.createBranch({ name: "--delete" }, directory)).rejects.toThrow();
    await GitModule.execute(directory, ["tag", "tag-only"]);
    await expect(service.showBranch("tag-only", directory)).rejects.toThrow(
      "Local branch not found",
    );
  });

  test("fetches and publishes only to the explicitly named local bare remote", async () => {
    const remote = join(directory, "remote.git");
    await GitModule.execute(directory, ["init", "--bare", remote]);
    await GitModule.execute(directory, [
      "--git-dir",
      remote,
      "symbolic-ref",
      "HEAD",
      "refs/heads/main",
    ]);
    const service = new GitService(createExecution({ dryRun: false }));
    await service.publishBranch({ name: "main", remote }, directory);
    await service.fetch({ remote }, directory);
    expect(
      await GitModule.execute(directory, ["--git-dir", remote, "rev-parse", "refs/heads/main"]),
    ).toBe(await GitModule.resolveCommit(directory));
  });
});
