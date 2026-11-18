import { mock, test, expect } from "bun:test";
import type { AzureDiffGitClient } from "../diff";
import { readAzurePullRequestDiff } from "../diff";
import type {
  GitPullRequest,
  GitPullRequestChange,
  GitPullRequestIteration,
} from "azure-devops-node-api/interfaces/GitInterfaces";

const pr = (repositoryId = "repo-id", projectId = "project-id"): GitPullRequest => ({
  pullRequestId: 42,
  repository: { id: repositoryId, project: { id: projectId } },
});

const iteration = (overrides: Partial<GitPullRequestIteration> = {}): GitPullRequestIteration => ({
  id: 3,
  sourceRefCommit: { commitId: "source" },
  targetRefCommit: { commitId: "base" },
  commonRefCommit: { commitId: "common" },
  ...overrides,
});

test("Azure diff reader requests every change page against compareTo0 and freezes the snapshot", async () => {
  const first: GitPullRequestChange = { changeId: 1 };
  const second: GitPullRequestChange = { changeId: 2 };
  let page = 0;
  const getPullRequestIterationChanges = mock<AzureDiffGitClient["getPullRequestIterationChanges"]>(
    async (_repository, _pr, _iteration, _project, _top, skip, compareTo) => {
      expect(compareTo).toBe(0);
      if (page++ === 0) {
        expect(skip).toBe(0);
        return { changeEntries: [first], nextSkip: 1 };
      }
      expect(skip).toBe(1);
      return { changeEntries: [second], nextSkip: 0 };
    },
  );
  let prReads = 0;
  const git: AzureDiffGitClient = {
    getPullRequestById: async () => pr(++prReads === 2 ? "REPO-ID" : "repo-id"),
    getPullRequestIterations: async () => [iteration()],
    getPullRequestIterationChanges,
  };

  const result = await readAzurePullRequestDiff(git, 42);

  expect(result.snapshot).toEqual({
    pullRequestId: 42,
    repositoryId: "repo-id",
    projectId: "project-id",
    iterationId: 3,
    sourceCommit: "source",
    baseCommit: "base",
    commonCommit: "common",
  });
  expect(result.changes.map((change) => change.changeId)).toEqual([1, 2]);
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result.snapshot)).toBe(true);
  expect(Object.isFrozen(result.changes)).toBe(true);
  expect(getPullRequestIterationChanges).toHaveBeenCalledTimes(2);
});

test("Azure diff reader rejects a changed iteration snapshot", async () => {
  let iterationReads = 0;
  const git: AzureDiffGitClient = {
    getPullRequestById: async () => pr(),
    getPullRequestIterations: async () => [
      iteration(iterationReads++ === 0 ? {} : { sourceRefCommit: { commitId: "changed" } }),
    ],
    getPullRequestIterationChanges: async () => ({ changeEntries: [] }),
  };

  await expect(readAzurePullRequestDiff(git, 42)).rejects.toMatchObject({
    code: "SCM_INVALID_RESPONSE",
  });
});

test("Azure diff reader rejects missing entries rather than reporting an empty diff", async () => {
  const git: AzureDiffGitClient = {
    getPullRequestById: async () => pr(),
    getPullRequestIterations: async () => [iteration()],
    getPullRequestIterationChanges: async () => ({}),
  };

  await expect(readAzurePullRequestDiff(git, 42)).rejects.toMatchObject({
    code: "SCM_INVALID_RESPONSE",
  });
});

test("Azure diff reader rejects a changed canonical repository", async () => {
  let prReads = 0;
  const git: AzureDiffGitClient = {
    getPullRequestById: async () => (++prReads === 1 ? pr() : pr("other-repo")),
    getPullRequestIterations: async () => [iteration()],
    getPullRequestIterationChanges: async () => ({ changeEntries: [] }),
  };

  await expect(readAzurePullRequestDiff(git, 42)).rejects.toMatchObject({
    code: "SCM_INVALID_RESPONSE",
  });
});
