import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { TooltipProvider } from "../ui/tooltip";
import { KanbanBoard } from "./kanban-board";

test("renders native tasks read-only without drag controls", () => {
  const markup = renderToStaticMarkup(
    createElement(
      TooltipProvider,
      null,
      createElement(KanbanBoard, {
        readOnly: true,
        columns: [
          {
            id: "deferred",
            title: "deferred",
            items: [
              {
                id: "eden-8.1",
                key: "eden-8.1",
                title: "A native decision",
                type: "decision",
                priority: "P4",
              },
            ],
          },
        ],
      }),
    ),
  );

  expect(markup).toContain("A native decision");
  expect(markup).toContain("eden-8.1");
  expect(markup).toContain('aria-label="deferred"');
  expect(markup).not.toContain('aria-roledescription="sortable"');
  expect(markup).not.toContain('role="button"');
  expect(markup).not.toContain("DndDescribedBy");
});
