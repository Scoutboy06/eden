import { Octokit } from "@octokit/rest";
import { GitHubApiProvider } from "../../github-provider";

export function githubProvider(
  respond: (url: URL, request: RequestInit) => Response | Promise<Response>,
) {
  const calls: URL[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    calls.push(url);

    const response = await respond(url, init ?? {});
    Object.defineProperty(response, "url", { value: url.href });

    return response;
  };

  return {
    provider: new GitHubApiProvider(
      new Octokit({ request: { fetch }, log: { debug() {}, info() {}, warn() {}, error() {} } }),
    ),
    calls,
  };
}

export function githubPr(overrides: Record<string, unknown> = {}) {
  return {
    number: 12,
    html_url: "https://github.com/acme/app/pull/12",
    title: "Improve login",
    body: null,
    state: "open",
    merged: false,
    draft: true,
    head: { ref: "topic", sha: "abc" },
    base: { ref: "main" },
    ...overrides,
  };
}
