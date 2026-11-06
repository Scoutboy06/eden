import { KanbanIcon, LeftToRightListBulletIcon, TableIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useSearchParams } from "react-router-dom";

import { KanbanBoard, type KanbanColumnData } from "@/components/kanban/kanban-board";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

const views = [
  { value: "board", label: "Board", icon: KanbanIcon },
  { value: "list", label: "List", icon: LeftToRightListBulletIcon },
  { value: "table", label: "Table", icon: TableIcon },
] as const;

const columns: KanbanColumnData[] = [
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

type View = (typeof views)[number]["value"];

function isView(value: string | null): value is View {
  return views.some((view) => view.value === value);
}

export function BoardPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = searchParams.get("view");
  const view: View = isView(requested) ? requested : "board";

  return (
    <Tabs
      value={view}
      onValueChange={(next) => setSearchParams(next === "board" ? {} : { view: String(next) })}
      className="flex flex-1 flex-col gap-0"
    >
      <header className="flex flex-wrap items-center justify-between gap-3 pb-3">
        <div>
          <h1 className="font-heading text-lg font-bold">Board</h1>
          <p className="text-sm text-muted-foreground">
            Everything planned, in progress, and done.
          </p>
        </div>
        <TabsList aria-label="View">
          {views.map(({ value, label, icon }) => (
            <TabsTrigger key={value} value={value}>
              <HugeiconsIcon icon={icon} strokeWidth={2} />
              {label}
            </TabsTrigger>
          ))}
        </TabsList>
      </header>
      <Separator />
      <TabsContent value="board" className="flex pt-4">
        <KanbanBoard columns={columns} />
      </TabsContent>
      {views
        .filter(({ value }) => value !== "board")
        .map(({ value, label }) => (
          <TabsContent key={value} value={value} className="pt-4">
            <p>{label} view</p>
          </TabsContent>
        ))}
    </Tabs>
  );
}
