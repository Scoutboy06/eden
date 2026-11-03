import { ScmError } from "./errors";
import type { PullRequestProvider, RepositoryRef } from "./provider";
import {
  createGitContext,
  resolvePullRequestLookup,
  type GitContext,
  type PullRequestInput,
} from "./resolve";
import { repositoryUrl } from "./targets";

export class PullRequestService {
  constructor(
    private readonly git: GitContext = createGitContext(process.cwd()),
    private readonly createProvider: (
      repository: RepositoryRef,
    ) => Promise<PullRequestProvider> = async (repository) => {
      const { createPullRequestProvider } = await import("./factory");

      return createPullRequestProvider(repository);
    },
  ) {}

  async show(input: PullRequestInput & { raw?: boolean; comments?: boolean; checks?: boolean }) {
    const { provider, ref } = await this.resolve(input);
    const [pr, comments, checks] = await Promise.all([
      provider.getPullRequest(ref, { raw: input.raw }),
      input.comments ? provider.getComments(ref) : undefined,
      input.checks ? provider.getChecks(ref) : undefined,
    ]);

    return {
      ...pr,
      ...(comments !== undefined ? { comments } : {}),
      ...(checks !== undefined ? { checks } : {}),
    };
  }

  async checks(input: PullRequestInput) {
    const { provider, ref } = await this.resolve(input);

    return { ref, checks: await provider.getChecks(ref) };
  }

  async reviewers(input: PullRequestInput) {
    const { provider, ref } = await this.resolve(input);

    return { ref, reviews: await provider.getReviews(ref) };
  }

  private async resolve(input: PullRequestInput) {
    const lookup = await resolvePullRequestLookup(input, this.git);
    const provider = await this.createProvider(lookup.repository);
    if (lookup.kind === "exact") return { provider, ref: lookup.ref };

    const candidates = await provider.findOpenPullRequests({
      repository: lookup.repository,
      sourceBranch: lookup.sourceBranch,
    });
    if (candidates.length === 0)
      throw new ScmError("SCM_NOT_FOUND", "No open PR was found for the selected source branch.");
    if (candidates.length > 1) {
      const urls = candidates.map(
        (ref) =>
          `${repositoryUrl(lookup.repository)}/${ref.provider === "github" ? `pull/${ref.number}` : `pullrequest/${ref.id}`}`,
      );
      throw new ScmError(
        "SCM_AMBIGUOUS_PULL_REQUEST",
        `Multiple open PRs match. Supply an exact PR number or URL:\n${urls.join("\n")}`,
      );
    }

    return { provider, ref: candidates[0]! };
  }
}
