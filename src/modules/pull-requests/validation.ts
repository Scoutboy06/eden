import { ScmError } from "./errors";
import type {
  PullRequestCreateInput,
  PullRequestPatch,
  PullRequestRef,
  RepositoryRef,
} from "./provider";

export function validateCreate(
  input: Omit<PullRequestCreateInput, "repository"> & { repository: RepositoryRef },
) {
  if (input.repository.provider === "github") {
    const hasOwner = input.repository.owner.trim().length > 0;
    const hasRepository = input.repository.repository.trim().length > 0;

    if (!hasOwner || !hasRepository) invalidInput("A GitHub repository target is required.");
  } else {
    const hasOrganization = input.repository.organizationUrl.trim().length > 0;
    const hasProject = input.repository.project.trim().length > 0;
    const hasRepository = input.repository.repository.trim().length > 0;

    if (!hasOrganization || !hasProject || !hasRepository)
      invalidInput("An Azure DevOps organization, project, and repository target are required.");
  }

  if (!input.title.trim()) invalidInput("A pull request title must not be blank.");

  const hasInvalidReviewer = input.reviewers?.some((name) => {
    const exceedsLoginLength = name.length > 39;
    const isLogin = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(name);

    return exceedsLoginLength || !isLogin;
  });
  if (hasInvalidReviewer) invalidInput("Reviewers must be GitHub user logins, not teams or URLs.");

  const hasInvalidLabel = input.labels?.some((name) => !name.trim() || /[\r\n\0]/.test(name));
  if (hasInvalidLabel)
    invalidInput("Labels must be nonempty names without null bytes or line breaks.");

  validateBranch(input.sourceBranch);
  validateBranch(input.targetBranch);
}

export function validateEdit(ref: PullRequestRef, patch: PullRequestPatch) {
  validateReference(ref);

  const keys = Object.keys(patch);
  const allowedKeys = ["title", "body", "targetBranch", "isDraft"];
  const hasUnsupportedKey = keys.some((key) => !allowedKeys.includes(key));
  if (hasUnsupportedKey) invalidInput("Only title, body, targetBranch, and isDraft may be edited.");
  if (keys.length === 0) invalidInput("At least one pull request field must be changed.");
  if (patch.title !== undefined && !patch.title.trim())
    invalidInput("A pull request title must not be blank.");

  if (patch.targetBranch !== undefined) validateBranch(patch.targetBranch);
}

export function validateReference(ref: PullRequestRef) {
  if (ref.provider === "github") {
    const hasOwner = ref.owner.trim().length > 0;
    const hasRepository = ref.repository.trim().length > 0;
    const hasValidNumber = Number.isSafeInteger(ref.number) && ref.number >= 1;

    if (!hasOwner || !hasRepository || !hasValidNumber)
      invalidInput("A valid exact GitHub pull request target is required.");
  } else {
    const hasOrganization = ref.organizationUrl.trim().length > 0;
    const hasValidId = Number.isSafeInteger(ref.id) && ref.id >= 1;

    if (!hasOrganization || !hasValidId)
      invalidInput("A valid exact Azure DevOps pull request target is required.");
  }
}

export function uniqueReviewTargets(values: string[], kind: "reviewer" | "team"): string[] {
  const pattern = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9])?$/;
  const targets: string[] = [];

  for (const value of values) {
    const splitTargets = value.split(",");
    for (const target of splitTargets) {
      targets.push(target.trim());
    }
  }

  const hasInvalidTarget = targets.some((target) => {
    const isEmpty = target.length === 0;
    const exceedsMaximumLength = target.length > 100;
    const matchesPattern = pattern.test(target);

    return isEmpty || exceedsMaximumLength || !matchesPattern;
  });
  if (hasInvalidTarget) {
    const targetType = kind === "reviewer" ? "user logins" : "team slugs";
    throw new ScmError(
      "SCM_INVALID_OPTIONS",
      `Invalid ${kind} target; supply GitHub ${targetType}.`,
    );
  }

  const uniqueTargets = new Map<string, string>();
  for (const target of targets) {
    const normalizedTarget = target.toLowerCase();
    uniqueTargets.set(normalizedTarget, target);
  }

  return Array.from(uniqueTargets.values());
}

function validateBranch(branch: string) {
  const hasForbiddenCharacter = /[~^:?*[\\]/.test(branch);
  const hasControlCharacter = [...branch].some((character) => {
    const codePoint = character.charCodeAt(0);

    return codePoint <= 32 || codePoint === 127;
  });
  const hasInvalidEnding = branch.endsWith("/") || branch.endsWith(".lock");

  if (
    branch.length === 0 ||
    branch.startsWith("-") ||
    hasForbiddenCharacter ||
    hasControlCharacter ||
    branch.includes("..") ||
    hasInvalidEnding
  )
    invalidInput("A valid Git branch name is required.");
}

export function validateDiffPath(pattern: string) {
  const hasInvalidSegment = pattern.split("/").some((segment) => segment === "..");
  const hasInvalidPath =
    pattern.trim().length === 0 ||
    pattern.startsWith("/") ||
    pattern.includes("\\") ||
    pattern.includes("\0") ||
    hasInvalidSegment;

  if (hasInvalidPath)
    throw new ScmError(
      "SCM_INVALID_OPTIONS",
      "--path must be a nonempty repository-relative glob.",
    );
}

export function matchesDiffPath(glob: Bun.Glob, path: string, previousPath?: string): boolean {
  const matchesCurrentPath = glob.match(path);
  if (matchesCurrentPath) return true;
  if (previousPath === undefined) return false;

  return glob.match(previousPath);
}

export function invalidInput(message: string): never {
  throw new ScmError("SCM_INVALID_REFERENCE", message);
}
