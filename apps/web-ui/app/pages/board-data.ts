import type { IssueGroup } from "@/components/issue/issue";

/** Sample issues until the board is backed by real data. */
export const sampleGroups: IssueGroup[] = [
  {
    id: "backlog",
    title: "Backlog",
    items: [
      {
        id: "1",
        key: "EDEN-14",
        title: "Drag and drop cards between columns",
        type: "story",
        priority: "high",
        labels: ["board"],
      },
      {
        id: "2",
        key: "EDEN-17",
        title: "Keyboard shortcuts for switching views",
        type: "task",
        priority: "low",
      },
      {
        id: "3",
        key: "EDEN-19",
        title: "Theme picker forgets selection on reload",
        type: "bug",
        priority: "medium",
        labels: ["settings"],
        commentCount: 2,
      },
    ],
  },
  {
    id: "todo",
    title: "To do",
    items: [
      {
        id: "4",
        key: "EDEN-11",
        title: "List view with grouping by status",
        type: "story",
        priority: "medium",
        labels: ["list"],
        assignee: { name: "Elias Wennerlund" },
        dueDate: "2026-11-20",
      },
      {
        id: "5",
        key: "EDEN-12",
        title: "Table view column sorting",
        type: "task",
        priority: "medium",
        labels: ["table"],
      },
    ],
  },
  {
    id: "in-progress",
    title: "In progress",
    items: [
      {
        id: "6",
        key: "EDEN-9",
        title: "Kanban card contents",
        type: "story",
        priority: "highest",
        labels: ["board", "ui"],
        assignee: { name: "Elias Wennerlund" },
        dueDate: "2026-11-04",
        commentCount: 5,
      },
      {
        id: "7",
        key: "EDEN-10",
        title: "Project selector overflows on narrow screens",
        type: "bug",
        priority: "high",
        assignee: { name: "Claude" },
        commentCount: 1,
      },
    ],
  },
  {
    id: "done",
    title: "Done",
    items: [
      {
        id: "8",
        key: "EDEN-8",
        title: "Board page header with view tabs",
        type: "story",
        priority: "medium",
        labels: ["board"],
        assignee: { name: "Elias Wennerlund" },
        done: true,
      },
    ],
  },
];
