import { expect, test } from "bun:test";
import { githubPr, githubProvider } from "./support/github";

const ref = { provider: "github" as const, owner: "acme", repository: "app", number: 12 };

test("adds and removes labels using label-specific endpoints without replacing labels", async () => {
  const requests: { method?: string; pathname: string; body?: unknown }[] = [];
  const { provider } = githubProvider((url, request) => {
    requests.push({
      method: request.method,
      pathname: url.pathname,
      ...(request.body ? { body: JSON.parse(String(request.body)) } : {}),
    });
    if (url.pathname.endsWith("/pulls/12")) return Response.json(githubPr());
    if (url.pathname.endsWith("/issues/12/labels") && request.method === "POST")
      return Response.json([{ name: "new-label" }]);
    if (url.pathname.endsWith("/issues/12/labels/old-label"))
      return new Response(null, { status: 204 });
    return Response.json({ message: "unexpected" }, { status: 500 });
  });

  await expect(
    provider.editPullRequest(ref, { addLabels: ["new-label"], removeLabels: ["old-label"] }),
  ).resolves.toMatchObject({ ref, title: "Improve login" });
  expect(requests.map(({ method, pathname }) => [method, pathname])).toEqual([
    ["GET", "/repos/acme/app/pulls/12"],
    ["POST", "/repos/acme/app/issues/12/labels"],
    ["DELETE", "/repos/acme/app/issues/12/labels/old-label"],
    ["GET", "/repos/acme/app/pulls/12"],
  ]);
  expect(requests[1]?.body).toEqual({ labels: ["new-label"] });
});

test("treats already-absent labels as unchanged and reports partial label failures", async () => {
  const { provider } = githubProvider((url, request) => {
    if (url.pathname.endsWith("/pulls/12")) return Response.json(githubPr());
    if (url.pathname.endsWith("/issues/12/labels/missing"))
      return Response.json({ message: "Label not found" }, { status: 404 });
    if (url.pathname.endsWith("/issues/12/labels") && request.method === "POST")
      return Response.json({ message: "Unavailable" }, { status: 500 });
    return Response.json({ message: "unexpected" }, { status: 500 });
  });

  await expect(provider.editPullRequest(ref, { removeLabels: ["missing"] })).resolves.toMatchObject(
    { title: "Improve login" },
  );
  await expect(provider.editPullRequest(ref, { addLabels: ["blocked"] })).rejects.toMatchObject({
    code: "SCM_PARTIAL_FAILURE",
  });
});

test("rejects an unexpected PR identity before applying any label changes", async () => {
  let requests = 0;
  const { provider } = githubProvider((_url) => {
    requests++;
    return Response.json(githubPr({ number: 13 }));
  });

  await expect(provider.editPullRequest(ref, { addLabels: ["new-label"] })).rejects.toMatchObject({
    code: "SCM_INVALID_RESPONSE",
  });
  expect(requests).toBe(1);
});
