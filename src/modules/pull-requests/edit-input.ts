import { ScmError } from "./errors";
import type { PullRequestPatch } from "./provider";

export interface PullRequestEditOptions {
  title?: string;
  body?: string;
  bodyFile?: string;
  targetBranch?: string;
  draft?: boolean;
  ready?: boolean;
  addLabels?: string[];
  removeLabels?: string[];
}

export async function buildPullRequestPatch(
  options: PullRequestEditOptions,
): Promise<PullRequestPatch> {
  if (options.draft && options.ready)
    throw new ScmError("SCM_INVALID_OPTIONS", "--draft and --ready are mutually exclusive.");
  if (options.body !== undefined && options.bodyFile !== undefined)
    throw new ScmError("SCM_INVALID_OPTIONS", "--body and --body-file are mutually exclusive.");
  let body = options.body;
  if (options.bodyFile !== undefined) {
    try {
      body = await Bun.file(options.bodyFile).text();
    } catch {
      throw new ScmError("SCM_BODY_FILE_FAILED", "Could not read --body-file.");
    }
  }

  return {
    ...(options.title !== undefined ? { title: options.title } : {}),
    ...(body !== undefined ? { body } : {}),
    ...(options.targetBranch !== undefined ? { targetBranch: options.targetBranch } : {}),
    ...(options.draft || options.ready ? { isDraft: !!options.draft } : {}),
    ...(options.addLabels !== undefined ? { addLabels: options.addLabels } : {}),
    ...(options.removeLabels !== undefined ? { removeLabels: options.removeLabels } : {}),
  };
}
