import { Octokit } from "@octokit/rest";
import { GitHubApiProvider } from "../../provider";

export function githubProvider(
  respond: (url: URL, request: RequestInit) => Response | Promise<Response>,
  token?: string,
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
      new Octokit({
        auth: token,
        request: { fetch },
        log: { debug() {}, info() {}, warn() {}, error() {} },
      }),
    ),
    calls,
  };
}

export function githubPr(overrides: Record<string, unknown> = {}) {
  return {
    number: 12,
    node_id: "PR_node_12",
    html_url: "https://github.com/acme/app/pull/12",
    title: "Improve login",
    body: null,
    state: "open",
    merged: false,
    draft: true,
    head: { ref: "topic", sha: "abc", repo: { owner: { login: "acme" }, name: "app" } },
    base: { ref: "main", sha: "base123", repo: { owner: { login: "acme" }, name: "app" } },
    ...overrides,
  };
}
