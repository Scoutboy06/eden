import { expect, test } from "bun:test";
import type { PullRequestRef } from "../../../modules/pull-requests/provider";
import { githubPr, githubProvider } from "./support/github";

const ref: PullRequestRef = { provider: "github", owner: "acme", repository: "app", number: 12 };

test("PR diff normalizes file metadata and marks omitted patches without guessing why", async () => {
  const { provider, calls } = githubProvider((url) => {
    if (url.pathname.endsWith("/pulls/12")) return Response.json(githubPr());
    if (url.pathname.endsWith("/pulls/12/files"))
      return Response.json([
        {
          filename: "src/new.ts",
          status: "added",
          additions: 3,
          deletions: 0,
          patch: "@@ -0,0 +1,3 @@\n+one\n+two\n+three",
        },
        {
          filename: "src/current.ts",
          previous_filename: "src/old.ts",
          status: "renamed",
          additions: 0,
          deletions: 0,
        },
        {
          filename: "src/truncated.ts",
          status: "modified",
          additions: 3,
          deletions: 0,
          patch: "@@ -0,0 +1,3 @@\n+one\n+two",
        },
      ]);
    throw new Error(`Unexpected ${url}`);
  });

  const diff = await provider.getDiff(ref);

  expect(diff).toEqual({
    ref,
    baseCommit: "base123",
    headCommit: "abc",
    files: [
      {
        path: "src/new.ts",
        status: "added",
        additions: 3,
        deletions: 0,
        patch: { status: "available", text: "@@ -0,0 +1,3 @@\n+one\n+two\n+three" },
      },
      {
        path: "src/current.ts",
        previousPath: "src/old.ts",
        status: "renamed",
        additions: 0,
        deletions: 0,
        patch: { status: "unavailable", reason: "not-provided" },
      },
      {
        path: "src/truncated.ts",
        status: "modified",
        additions: 3,
        deletions: 0,
        patch: { status: "truncated", text: "@@ -0,0 +1,3 @@\n+one\n+two" },
      },
    ],
    completeness: { status: "complete" },
  });
  expect(calls.map(({ pathname }) => pathname)).toEqual([
    "/repos/acme/app/pulls/12",
    "/repos/acme/app/pulls/12/files",
    "/repos/acme/app/pulls/12",
  ]);
});

test("PR diff fails rather than returning files from different PR commits or identities", async () => {
  let reads = 0;
  const { provider } = githubProvider((url) => {
    if (url.pathname.endsWith("/pulls/12")) {
      const response =
        reads++ === 0
          ? githubPr()
          : githubPr({
              base: { ...githubPr().base, repo: { owner: { login: "other" }, name: "repo" } },
            });

      return Response.json(response);
    }
    if (url.pathname.endsWith("/pulls/12/files")) return Response.json([]);
    throw new Error(`Unexpected ${url}`);
  });

  await expect(provider.getDiff(ref)).rejects.toMatchObject({ code: "SCM_INVALID_RESPONSE" });
});

test("PR diff fails when the head commit changes during file pagination", async () => {
  let reads = 0;
  const { provider } = githubProvider((url) => {
    if (url.pathname.endsWith("/pulls/12")) {
      const head = { ...githubPr().head, sha: reads++ === 0 ? "abc" : "changed" };

      return Response.json(githubPr({ head }));
    }
    if (url.pathname.endsWith("/pulls/12/files")) return Response.json([]);
    throw new Error(`Unexpected ${url}`);
  });

  await expect(provider.getDiff(ref)).rejects.toMatchObject({ code: "SCM_PARTIAL_FAILURE" });
});

test.each([
  [3000, "complete"],
  [3001, "incomplete"],
] as const)(
  "PR diff reports the 3,000-file cap against declared count %i",
  async (changedFiles, status) => {
    const { provider } = githubProvider((url) => {
      if (url.pathname.endsWith("/pulls/12"))
        return Response.json(githubPr({ changed_files: changedFiles }));
      if (url.pathname.endsWith("/pulls/12/files")) {
        const page = Number(url.searchParams.get("page") ?? 1);
        const headers =
          page < 30
            ? {
                link: `<https://api.github.com/repos/acme/app/pulls/12/files?per_page=100&page=${page + 1}>; rel="next"`,
              }
            : undefined;

        return Response.json(
          Array.from({ length: 100 }, (_, index) => ({
            filename: `src/file-${page}-${index}.ts`,
            status: "modified",
            additions: 0,
            deletions: 0,
          })),
          { headers },
        );
      }
      throw new Error(`Unexpected ${url}`);
    });

    expect((await provider.getDiff(ref)).completeness.status).toBe(status);
  },
);

test("raw PR fields are opt-in and preserve provider-specific data", async () => {
  const { provider } = githubProvider(() => Response.json(githubPr({ mergeable: true })));

  expect((await provider.getPullRequest(ref)).raw).toBeUndefined();
  expect((await provider.getPullRequest(ref, { raw: true })).raw).toMatchObject({
    mergeable: true,
  });
});
