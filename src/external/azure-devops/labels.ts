import { invalidResponse, providerRequest, ScmError } from "../../modules/pull-requests/errors";
import type { PullRequestPatch } from "../../modules/pull-requests/provider";
import type { AzureGitClient } from "./provider";

export async function planAzureLabelEdits(
  git: AzureGitClient,
  target: [repository: string, pullRequestId: number, project: string],
  patch: PullRequestPatch,
): Promise<(() => Promise<void>) | undefined> {
  const add = patch.addLabels ?? [];
  const remove = patch.removeLabels ?? [];
  if (add.length === 0 && remove.length === 0) return;

  const current = await readLabels(git, target);
  const additions = add.filter((name) => !current.has(name.toLowerCase()));
  const removals = remove.flatMap((name) => {
    const id = current.get(name.toLowerCase());
    return id === undefined ? [] : [id];
  });
  if (additions.length === 0 && removals.length === 0) return;

  const [repository, pullRequestId, project] = target;
  return async () => {
    try {
      for (const name of additions) await git.createPullRequestLabel({ name }, ...target);
      for (const id of removals) {
        try {
          await providerRequest(() =>
            git.deletePullRequestLabels(repository, pullRequestId, id, project),
          );
        } catch (error) {
          if (!(error instanceof ScmError) || error.code !== "SCM_NOT_FOUND") throw error;
        }
      }

      const updated = await readLabels(git, target);
      const missingAddition = add.some((name) => !updated.has(name.toLowerCase()));
      const remainingRemoval = remove.some((name) => updated.has(name.toLowerCase()));
      if (missingAddition || remainingRemoval) invalidResponse();
    } catch {
      throw new ScmError(
        "SCM_PARTIAL_FAILURE",
        "PR fields or labels may have changed, but the requested label state could not be confirmed.",
      );
    }
  };
}

async function readLabels(
  git: AzureGitClient,
  target: [repository: string, pullRequestId: number, project: string],
) {
  const labels = await git.getPullRequestLabels(...target);
  if (!Array.isArray(labels)) invalidResponse();

  const byName = new Map<string, string>();
  for (const label of labels) {
    if (typeof label?.name !== "string" || !label.name || typeof label.id !== "string" || !label.id)
      invalidResponse();
    const name = label.name.toLowerCase();
    if (byName.has(name)) invalidResponse();
    byName.set(name, label.id);
  }

  return byName;
}
