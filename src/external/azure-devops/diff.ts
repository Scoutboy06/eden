import type { IGitApi } from "azure-devops-node-api/GitApi";
import type {
  GitPullRequest,
  GitPullRequestChange,
  GitPullRequestIteration,
} from "azure-devops-node-api/interfaces/GitInterfaces";
import { invalidResponse, ScmError } from "../../modules/pull-requests/errors";
import { sameAzureIdentity } from "./normalize";

export type AzureDiffGitClient = Pick<
  IGitApi,
  "getPullRequestById" | "getPullRequestIterations" | "getPullRequestIterationChanges"
>;

export type AzureDiffSnapshot = Readonly<{
  pullRequestId: number;
  repositoryId: string;
  projectId: string;
  iterationId: number;
  sourceCommit: string;
  baseCommit: string;
  commonCommit: string;
}>;

export type AzureDiffChange = Readonly<GitPullRequestChange>;

export type AzurePullRequestDiff = Readonly<{
  snapshot: AzureDiffSnapshot;
  changes: readonly AzureDiffChange[];
}>;

type CanonicalIdentity = Readonly<{ repositoryId: string; projectId: string }>;

export async function readAzurePullRequestDiff(
  git: AzureDiffGitClient,
  pullRequestId: number,
): Promise<AzurePullRequestDiff> {
  if (!Number.isSafeInteger(pullRequestId) || pullRequestId <= 0) invalidResponse();

  const initialPullRequest = await git.getPullRequestById(pullRequestId);
  assertPullRequestId(initialPullRequest, pullRequestId);
  const identity = canonicalIdentity(initialPullRequest);
  const iterations = await git.getPullRequestIterations(
    identity.repositoryId,
    pullRequestId,
    identity.projectId,
    false,
  );
  const iteration = latestIteration(iterations);
  const snapshot = makeSnapshot(iteration, pullRequestId, identity);
  const changes = await readChanges(git, snapshot);

  await confirmAzureDiffSnapshot(git, snapshot);

  return Object.freeze({ snapshot, changes: Object.freeze(changes) });
}

export async function confirmAzureDiffSnapshot(
  git: AzureDiffGitClient,
  snapshot: AzureDiffSnapshot,
): Promise<void> {
  const [pr, iterations] = await Promise.all([
    git.getPullRequestById(snapshot.pullRequestId),
    git.getPullRequestIterations(
      snapshot.repositoryId,
      snapshot.pullRequestId,
      snapshot.projectId,
      false,
    ),
  ]);
  assertPullRequestId(pr, snapshot.pullRequestId);
  assertIdentity(pr, snapshot);
  assertSnapshot(snapshot, latestIteration(iterations));
}

async function readChanges(
  git: AzureDiffGitClient,
  snapshot: AzureDiffSnapshot,
): Promise<AzureDiffChange[]> {
  const changes: AzureDiffChange[] = [];
  let skip = 0;

  for (;;) {
    const page = await git.getPullRequestIterationChanges(
      snapshot.repositoryId,
      snapshot.pullRequestId,
      snapshot.iterationId,
      snapshot.projectId,
      200,
      skip,
      0,
    );
    if (!Array.isArray(page.changeEntries)) invalidResponse();
    changes.push(...page.changeEntries);
    const nextSkip = page.nextSkip ?? 0;
    if (nextSkip === 0) return changes;
    if (nextSkip <= skip) invalidResponse();
    skip = nextSkip;
  }
}

function assertPullRequestId(pr: GitPullRequest, expectedId: number): void {
  if (pr.pullRequestId !== expectedId) invalidResponse();
}

function canonicalIdentity(pr: GitPullRequest): CanonicalIdentity {
  const repositoryId = pr.repository?.id;
  const projectId = pr.repository?.project?.id;
  if (!repositoryId || !projectId) invalidResponse();
  return Object.freeze({ repositoryId, projectId });
}

function assertIdentity(pr: GitPullRequest, identity: CanonicalIdentity): void {
  if (
    !sameAzureIdentity(pr.repository?.id, identity.repositoryId) ||
    !sameAzureIdentity(pr.repository?.project?.id, identity.projectId)
  )
    invalidResponse();
}

function latestIteration(iterations: GitPullRequestIteration[]): GitPullRequestIteration {
  const iteration = iterations.reduce<GitPullRequestIteration | undefined>((latest, current) => {
    if (typeof current.id !== "number") return latest;
    if (!latest || (current.id ?? 0) > (latest.id ?? 0)) return current;
    return latest;
  }, undefined);
  if (!iteration) invalidResponse();
  return iteration;
}

function makeSnapshot(
  iteration: GitPullRequestIteration,
  pullRequestId: number,
  identity: CanonicalIdentity,
): AzureDiffSnapshot {
  const sourceCommit = iteration.sourceRefCommit?.commitId;
  const baseCommit = iteration.targetRefCommit?.commitId;
  const commonCommit = iteration.commonRefCommit?.commitId;
  if (!iteration.id || !sourceCommit || !baseCommit || !commonCommit) invalidResponse();
  return Object.freeze({
    pullRequestId,
    ...identity,
    iterationId: iteration.id,
    sourceCommit,
    baseCommit,
    commonCommit,
  });
}

function assertSnapshot(snapshot: AzureDiffSnapshot, iteration: GitPullRequestIteration): void {
  const current = makeSnapshot(iteration, snapshot.pullRequestId, snapshot);
  if (
    current.iterationId !== snapshot.iterationId ||
    current.sourceCommit !== snapshot.sourceCommit ||
    current.baseCommit !== snapshot.baseCommit ||
    current.commonCommit !== snapshot.commonCommit
  )
    throw new ScmError("SCM_INVALID_RESPONSE", "The pull request changed while its diff was read.");
}
