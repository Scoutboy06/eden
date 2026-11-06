import { KanbanIcon, LeftToRightListBulletIcon, TableIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import { useSearchParams } from "react-router-dom";

import { IssueTable } from "@/components/issue-table/issue-table";
import { IssueList } from "@/components/issue-list/issue-list";
import { KanbanBoard } from "@/components/kanban/kanban-board";
import { sampleGroups } from "@/pages/board-data";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

const views = [
  { value: "board", label: "Board", icon: KanbanIcon },
  { value: "list", label: "List", icon: LeftToRightListBulletIcon },
  { value: "table", label: "Table", icon: TableIcon },
] as const;

type View = (typeof views)[number]["value"];

function isView(value: string | null): value is View {
  return views.some((view) => view.value === value);
}

export function BoardPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = searchParams.get("view");
  const view: View = isView(requested) ? requested : "board";
  // Shared by every view, so a card moved on the board shows up in the list too.
  const [groups, setGroups] = useState(sampleGroups);

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
        <KanbanBoard columns={groups} onColumnsChange={setGroups} />
      </TabsContent>
      <TabsContent value="list" className="pt-4">
        <IssueList groups={groups} />
      </TabsContent>
      <TabsContent value="table" className="pt-4">
        <IssueTable groups={groups} />
      </TabsContent>
    </Tabs>
  );
}
