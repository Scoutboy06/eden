import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { WorktreeCard } from "./worktree-card";

test("renders a selectable worktree button and keeps its external PR link independent", () => {
  const markup = renderToStaticMarkup(
    <WorktreeCard
      worktree={{
        name: "topic",
        branch: "feature/topic",
        state: "available",
        pr: {
          ref: { provider: "github", number: 42 },
          title: "Improve login",
          url: "https://github.com/acme/app/pull/42",
          state: "open",
          isDraft: true,
        },
        reviews: [{ name: "alice", state: "approved" }],
        checks: [{ name: "build", state: "passed" }],
      }}
      selected
      onSelect={() => {}}
    />,
  );

  expect(markup).toContain('type="button"');
  expect(markup).toContain('aria-pressed="true"');
  expect(markup).toContain("Open topic on feature/topic in Doing");
  expect(markup).toContain("https://github.com/acme/app/pull/42");
  expect(markup).toContain("Improve login");
  expect(markup.indexOf("</button>")).toBeLessThan(markup.indexOf("<a "));
});
