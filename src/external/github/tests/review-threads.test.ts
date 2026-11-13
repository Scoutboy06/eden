import { expect, test } from "bun:test";
import { githubPr, githubProvider } from "./support/github";

const ref = { provider: "github" as const, owner: "acme", repository: "app", number: 12 };

test("lists review threads with identity, resolution, usable reply IDs and honest limit state", async () => {
  const { provider, calls } = githubProvider((url) =>
    url.pathname === "/graphql"
      ? Response.json({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: [
                    {
                      id: "thread-node-1",
                      isResolved: false,
                      comments: {
                        nodes: [
                          {
                            databaseId: 56,
                            body: "Root",
                            createdAt: "2026-11-10T00:00:00Z",
                            path: "src/a.ts",
                            line: 4,
                            user: { databaseId: 7, login: "alice" },
                            replyTo: null,
                          },
                        ],
                        pageInfo: { hasNextPage: true },
                      },
                    },
                    {
                      id: "thread-node-2",
                      isResolved: true,
                      comments: {
                        nodes: [
                          {
                            databaseId: 57,
                            body: "Resolved",
                            createdAt: "2026-11-11T00:00:00Z",
                            user: null,
                            replyTo: null,
                          },
                        ],
                        pageInfo: { hasNextPage: false },
                      },
                    },
                  ],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          },
        })
      : Response.json(githubPr()),
  );

  const result = await provider.listCommentThreads(ref, { unresolved: true, limit: 1 });

  expect(result).toEqual({
    threads: [
      [
        expect.objectContaining({
          id: "review:56",
          threadId: "thread-node-1",
          replyTo: "review:56",
          isResolved: false,
          path: "src/a.ts",
        }),
      ],
    ],
    hasMore: false,
    incomplete: true,
  });
  expect(calls.map((url) => url.pathname)).toEqual(["/graphql"]);
});

test("reports more filtered review threads when the requested limit is reached", async () => {
  const { provider } = githubProvider(() =>
    Response.json({
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [1, 2].map((id) => ({
                id: `thread-${id}`,
                isResolved: false,
                comments: {
                  nodes: [
                    {
                      databaseId: id,
                      body: "Review",
                      createdAt: "2026-11-10T00:00:00Z",
                      user: null,
                      replyTo: null,
                    },
                  ],
                  pageInfo: { hasNextPage: false },
                },
              })),
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
    }),
  );

  await expect(provider.listCommentThreads(ref, { limit: 1 })).resolves.toMatchObject({
    threads: [[{ id: "review:1" }]],
    hasMore: true,
  });
});

test("continues pagination when earlier threads do not match filters", async () => {
  let page = 0;
  const { provider, calls } = githubProvider(() => {
    page++;
    return Response.json({
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [
                {
                  id: `thread-${page}`,
                  isResolved: false,
                  comments: {
                    nodes: [
                      {
                        databaseId: page,
                        body: "Review",
                        createdAt: page === 1 ? "2026-11-01T00:00:00Z" : "2026-11-10T00:00:00Z",
                        user: null,
                        replyTo: null,
                      },
                    ],
                    pageInfo: { hasNextPage: false },
                  },
                },
              ],
              pageInfo: { hasNextPage: page === 1, endCursor: page === 1 ? "cursor-1" : null },
            },
          },
        },
      },
    });
  });

  const result = await provider.listCommentThreads(ref, {
    since: "2026-11-05",
    limit: 1,
  });

  expect(result).toMatchObject({ threads: [[{ id: "review:2" }]], hasMore: false });
  expect(calls).toHaveLength(2);
});
