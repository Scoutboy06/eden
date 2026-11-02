import { expect, test } from "bun:test";
import {
  parsePrNumber,
  parsePullRequestUrl,
  parseRemoteUrl,
  parseRepositoryUrl,
  repositoryKey,
} from "../targets";

test("parses hosted repository URLs with encoded Azure names", () => {
  expect(parseRepositoryUrl("https://github.com/acme/app.git/")).toEqual({
    provider: "github",
    owner: "acme",
    repository: "app",
  });
  expect(parseRepositoryUrl("https://dev.azure.com/acme/My%20Project/_git/My%20App")).toEqual({
    provider: "azure-devops",
    organizationUrl: "https://dev.azure.com/acme",
    project: "My Project",
    repository: "My App",
  });
});

test("preserves authoritative scope when parsing PR URLs", () => {
  expect(parsePullRequestUrl("https://github.com/acme/app/pull/12").ref).toEqual({
    provider: "github",
    owner: "acme",
    repository: "app",
    number: 12,
  });
  expect(
    parsePullRequestUrl("https://dev.azure.com/acme/Product/_git/app/pullrequest/456").ref,
  ).toEqual({ provider: "azure-devops", organizationUrl: "https://dev.azure.com/acme", id: 456 });
});

test.each([
  "acme/app",
  "http://github.com/acme/app",
  "https://github.example.com/acme/app",
  "https://github.com.evil.test/acme/app",
  "https://github.com@evil.test/acme/app",
  "https://user:secret@github.com/acme/app",
  "https://github.com/acme/app?token=secret",
  "https://github.com/acme/app#fragment",
  "https://github.com/acme/app/extra",
  "https://github.com/acme/%2Fsecret",
  "https://github.com/acme/%00secret",
  "https://dev.azure.com/acme/Product/_git/",
  "https://github.com:8080/acme/app",
])("rejects unsupported or unsafe repository URL %s", (url) => {
  expect(() => parseRepositoryUrl(url)).toThrow();
});

test.each(["0", "-1", "1.5", "1e2", "9007199254740992", "topic", "01"])(
  "rejects invalid PR number %s",
  (value) => {
    expect(() => parsePrNumber(value)).toThrow();
  },
);

test("normalizes HTTPS and SSH Git remotes to the same repository", () => {
  const github = parseRemoteUrl("git@github.com:Acme/App.git");
  const azure = parseRemoteUrl("git@ssh.dev.azure.com:v3/acme/Product/app");

  expect(repositoryKey(github)).toBe(repositoryKey(parseRemoteUrl("https://github.com/acme/app")));
  expect(repositoryKey(azure)).toBe(
    repositoryKey(parseRemoteUrl("https://user@dev.azure.com/acme/Product/_git/app")),
  );
  expect(parseRemoteUrl("ssh://git@github.com/Acme/App.git")).toEqual(github);
  expect(parseRemoteUrl("ssh://git@ssh.dev.azure.com/v3/acme/Product/app")).toEqual(azure);
});

test("rejects passwords in Git remote URLs without echoing them", () => {
  expect(() => parseRemoteUrl("https://user:secret@github.com/acme/app")).toThrow(
    "without credentials",
  );
});
