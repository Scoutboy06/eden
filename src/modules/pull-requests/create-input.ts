import { buildPullRequestPatch } from "./edit-input";
import { ScmError } from "./errors";

export async function buildPullRequestCreate(options: {
  title: string;
  base: string;
  body?: string;
  bodyFile?: string;
  draft?: boolean;
  reviewer?: string;
  label?: string;
}) {
  if (!options.title.trim() || !options.base.trim())
    throw new ScmError("SCM_INVALID_OPTIONS", "--title and --base must not be blank.");
  const patch = await buildPullRequestPatch(options);

  return {
    title: options.title,
    base: options.base,
    body: patch.body ?? "",
    draft: options.draft ?? false,
    reviewers: names(options.reviewer, "--reviewer"),
    labels: names(options.label, "--label"),
  };
}

function names(value: string | undefined, option: string): string[] {
  if (value === undefined) return [];
  const values = value.split(",").map((name) => name.trim());
  if (values.some((name) => !name))
    throw new ScmError(
      "SCM_INVALID_OPTIONS",
      `${option} requires nonempty comma-separated values.`,
    );

  return [...new Set(values)];
}
