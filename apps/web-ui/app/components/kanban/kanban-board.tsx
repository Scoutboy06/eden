import { cn } from "cn";
import type * as React from "react";

import { KanbanCard, type KanbanItem } from "./kanban-card";

export type KanbanColumnData = {
  id: string;
  title: string;
  items: KanbanItem[];
};

export function KanbanBoard({
  columns,
  className,
  ...props
}: React.ComponentProps<"div"> & { columns: KanbanColumnData[] }) {
  return (
    <div className={cn("flex flex-1 gap-4 overflow-x-auto pb-2", className)} {...props}>
      {columns.map((column) => (
        <KanbanColumn key={column.id} column={column} />
      ))}
    </div>
  );
}

function KanbanColumn({ column }: { column: KanbanColumnData }) {
  return (
    <section
      aria-label={column.title}
      className="flex w-72 shrink-0 flex-col gap-2 rounded-xl bg-muted/50 p-2"
    >
      <header className="flex items-center justify-between px-1 py-0.5">
        <h2 className="text-sm font-medium">{column.title}</h2>
        <span className="text-xs text-muted-foreground tabular-nums">{column.items.length}</span>
      </header>
      <div className="flex flex-col gap-2">
        {column.items.map((item) => (
          <KanbanCard key={item.id} item={item} />
        ))}
      </div>
    </section>
  );
}
