import { ScmError } from "./errors";
import type { PullRequestRef, RepositoryRef } from "./provider";

export function parseRepositoryUrl(input: string): RepositoryRef {
  const { host, parts } = parseUrl(input);

  if (host === "github.com" && parts.length === 2) {
    const [owner, repository] = parts as [string, string];

    return { provider: "github", owner, repository: stripGit(repository) };
  }

  if (host === "dev.azure.com" && parts.length === 4 && parts[2] === "_git") {
    const [organization, project, , repository] = parts as [string, string, string, string];

    return {
      provider: "azure-devops",
      organizationUrl: `https://dev.azure.com/${encodeURIComponent(organization)}`,
      project,
      repository: stripGit(repository),
    };
  }

  throw invalidTarget();
}

export function parsePullRequestUrl(input: string): {
  repository: RepositoryRef;
  ref: PullRequestRef;
} {
  const { host, parts } = parseUrl(input);

  if (host === "github.com" && parts.length === 4 && parts[2] === "pull") {
    const [owner, repository, , number] = parts as [string, string, string, string];

    return {
      repository: { provider: "github", owner, repository },
      ref: { provider: "github", owner, repository, number: parsePrNumber(number) },
    };
  }

  if (
    host === "dev.azure.com" &&
    parts.length === 6 &&
    parts[2] === "_git" &&
    parts[4] === "pullrequest"
  ) {
    const repository = parseRepositoryUrl(
      `https://${host}/${parts.slice(0, 4).map(encodeURIComponent).join("/")}`,
    );

    if (repository.provider !== "azure-devops") throw invalidTarget();

    return {
      repository,
      ref: {
        provider: "azure-devops",
        organizationUrl: repository.organizationUrl,
        id: parsePrNumber(parts[5]!),
      },
    };
  }

  throw invalidTarget();
}

export function parseRemoteUrl(input: string): RepositoryRef {
  const github = /^(?:git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+)\/([^/]+)\/?$/.exec(input);
  if (github) return parseRepositoryUrl(`https://github.com/${github[1]}/${github[2]}`);

  const azure =
    /^(?:git@ssh\.dev\.azure\.com:|ssh:\/\/git@ssh\.dev\.azure\.com\/)v3\/([^/]+)\/([^/]+)\/([^/]+)\/?$/.exec(
      input,
    );
  if (azure)
    return parseRepositoryUrl(`https://dev.azure.com/${azure[1]}/${azure[2]}/_git/${azure[3]}`);

  const url = new URL(input);
  if (url.password) throw invalidTarget();
  url.username = "";

  return parseRepositoryUrl(url.toString());
}

export function repositoryUrl(repository: RepositoryRef): string {
  return repository.provider === "github"
    ? `https://github.com/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repository)}`
    : `${repository.organizationUrl}/${encodeURIComponent(repository.project)}/_git/${encodeURIComponent(repository.repository)}`;
}

export function repositoryKey(repository: RepositoryRef): string {
  return repositoryUrl(repository).toLowerCase();
}

export function refForNumber(repository: RepositoryRef, number: number): PullRequestRef {
  return repository.provider === "github"
    ? { ...repository, number }
    : { provider: "azure-devops", organizationUrl: repository.organizationUrl, id: number };
}

export function parsePrNumber(input: string): number {
  const number = Number(input);
  if (!/^[1-9]\d*$/.test(input) || !Number.isSafeInteger(number))
    throw new ScmError("SCM_INVALID_REFERENCE", "A PR number must be a positive safe integer.");

  return number;
}

function parseUrl(input: string): { host: string; parts: string[] } {
  try {
    const url = new URL(input);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      url.search ||
      url.hash
    )
      throw invalidTarget();
    if (url.hostname !== "github.com" && url.hostname !== "dev.azure.com") throw invalidTarget();

    const parts = url.pathname.replace(/\/$/, "").slice(1).split("/").map(decodeURIComponent);
    if (
      parts.some(
        (part) =>
          !part ||
          [...part].some(
            (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
          ) ||
          /[/\\]/.test(part) ||
          part === "." ||
          part === "..",
      )
    )
      throw invalidTarget();

    return { host: url.hostname, parts };
  } catch {
    throw invalidTarget();
  }
}

function stripGit(value: string): string {
  const repository = value.replace(/\.git$/, "");
  if (!repository) throw invalidTarget();

  return repository;
}

function invalidTarget(): ScmError {
  return new ScmError(
    "SCM_INVALID_URL",
    "Use an HTTPS repository or PR URL on github.com or dev.azure.com, without credentials, a query or a fragment.",
  );
}
