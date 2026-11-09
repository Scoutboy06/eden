import { buildPullRequestPatch } from "./edit-input";
import { ScmError } from "./errors";
import type { PullRequestCommentInput } from "./provider";

export async function buildPullRequestComment(options: {
  body?: string;
  bodyFile?: string;
  replyTo?: string;
}): Promise<PullRequestCommentInput> {
  const patch = await buildPullRequestPatch(options);
  const input = {
    body: patch.body ?? "",
    ...(options.replyTo !== undefined ? { replyTo: options.replyTo } : {}),
  };
  validatePullRequestComment(input);

  return input;
}

export function validatePullRequestComment(input: PullRequestCommentInput): number | undefined {
  if (!input.body.trim())
    throw new ScmError(
      "SCM_INVALID_OPTIONS",
      "Supply a nonblank comment using --body or --body-file.",
    );
  if (input.replyTo === undefined) return;
  if (/^issue:[1-9][0-9]*$/.test(input.replyTo))
    throw new ScmError(
      "SCM_UNSUPPORTED_OPERATION",
      "GitHub discussion comments do not support native threaded replies. Use a top-level comment or --reply-to review:<id> for an inline review thread.",
    );
  const match = /^review:([1-9][0-9]*)$/.exec(input.replyTo);
  const id = match ? Number(match[1]) : NaN;
  if (!Number.isSafeInteger(id))
    throw new ScmError(
      "SCM_INVALID_OPTIONS",
      "--reply-to must be review:<positive comment ID>, as returned by pr show --comments.",
    );

  return id;
}
