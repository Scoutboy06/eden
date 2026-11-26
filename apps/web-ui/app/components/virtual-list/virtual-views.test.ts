import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { IssueList } from "@/components/issue-list/issue-list";
import { IssueTable } from "@/components/issue-table/issue-table";
import type { IssueGroup } from "@/components/issue/issue";
import { KanbanBoard } from "@/components/kanban/kanban-board";
import { TooltipProvider } from "@/components/ui/tooltip";

const tasks = Array.from({ length: 200 }, (_, index) => ({
  id: `eden-${index + 1}`,
  key: `EDEN-${index + 1}`,
  title: `Task ${index + 1}`,
  type: "task",
  priority: "P2" as const,
}));

const groups: IssueGroup[] = [{ id: "open", title: "Open", items: tasks }];

test("board renders a bounded card slice with collection positions", () => {
  const markup = renderToStaticMarkup(
    createElement(
      TooltipProvider,
      null,
      createElement(KanbanBoard, { readOnly: true, columns: groups }),
    ),
  );

  expect(markup).toContain("Task 1");
  expect(markup).not.toContain("Task 200");
  expect(markup).toContain('aria-setsize="200"');
  expect((markup.match(/data-index=/g) ?? []).length).toBeLessThan(40);
});

test("list renders a bounded slice while exposing the full group size", () => {
  const markup = renderToStaticMarkup(createElement(IssueList, { groups }));

  expect(markup).toContain("Task 1");
  expect(markup).not.toContain("Task 200");
  expect(markup).toContain('aria-setsize="200"');
  expect((markup.match(/aria-posinset=/g) ?? []).length).toBeLessThan(40);
});

test("table renders a bounded slice while keeping total row count", () => {
  const markup = renderToStaticMarkup(createElement(IssueTable, { groups }));

  expect(markup).toContain("Task 1");
  expect(markup).not.toContain("Task 200");
  expect(markup).toContain('aria-rowcount="201"');
  expect((markup.match(/aria-rowindex=/g) ?? []).length).toBeLessThan(40);
});
