import {
  closestCorners,
  DndContext,
  type DragEndEvent,
  type DragOverEvent,
  DragOverlay,
  type DragStartEvent,
  KeyboardSensor,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { cn } from "cn";
import { useState } from "react";
import type * as React from "react";

import type { Issue, IssueGroup } from "@/components/issue/issue";

import { KanbanCard } from "./kanban-card";

export type KanbanBoardProps = Omit<React.ComponentProps<"div">, "onChange"> & {
  columns: IssueGroup[];
  allowReorder?: boolean;
  readOnly?: boolean;
  /** Called with the new layout after a card is dropped. */
  onColumnsChange?: (columns: IssueGroup[]) => void;
};

/** Id of the column containing `id`, where `id` is a card or a column. */
function findColumnId(columns: IssueGroup[], id: string) {
  if (columns.some((column) => column.id === id)) return id;
  return columns.find((column) => column.items.some((item) => item.id === id))?.id;
}

export function KanbanBoard({
  columns: committedColumns,
  allowReorder = true,
  readOnly = false,
  onColumnsChange,
  className,
  ...props
}: KanbanBoardProps) {
  // Layout while a drag is in progress; committed to the parent on drop, discarded on cancel.
  const [draft, setDraft] = useState<IssueGroup[] | null>(null);
  const columns = draft ?? committedColumns;
  const [activeItem, setActiveItem] = useState<Issue | null>(null);

  const sensors = useSensors(
    // Small distance so clicks on a card still register as clicks.
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function handleDragStart({ active }: DragStartEvent) {
    const item = columns.flatMap((column) => column.items).find((i) => i.id === active.id);
    setActiveItem(item ?? null);
    setDraft(committedColumns);
  }

  // Move the card into another column while hovering, so that column makes room for it.
  function handleDragOver({ active, over }: DragOverEvent) {
    if (!over) return;
    const fromId = findColumnId(columns, String(active.id));
    const toId = findColumnId(columns, String(over.id));
    if (!fromId || !toId || fromId === toId) return;

    setDraft((current) => {
      const prev = current ?? committedColumns;
      const from = prev.find((c) => c.id === fromId)!;
      const to = prev.find((c) => c.id === toId)!;
      const item = from.items.find((i) => i.id === active.id)!;
      const overIndex = to.items.findIndex((i) => i.id === over.id);
      const insertAt = overIndex === -1 ? to.items.length : overIndex;

      return prev.map((column) => {
        if (column.id === fromId) {
          return { ...column, items: column.items.filter((i) => i.id !== active.id) };
        }
        if (column.id === toId) {
          const items = [...column.items];
          items.splice(insertAt, 0, item);
          return { ...column, items };
        }
        return column;
      });
    });
  }

  // Reorder within the final column.
  function handleDragEnd({ active, over }: DragEndEvent) {
    setActiveItem(null);
    setDraft(null);
    if (!over) return;

    const sourceColumnId = findColumnId(committedColumns, String(active.id));
    const destinationColumnId = findColumnId(columns, String(active.id));
    if (!allowReorder) {
      if (sourceColumnId !== destinationColumnId) onColumnsChange?.(columns);
      return;
    }

    // `columns` already includes any cross-column move made in handleDragOver.
    const columnId = findColumnId(columns, String(active.id));
    const column = columns.find((c) => c.id === columnId);
    const oldIndex = column?.items.findIndex((i) => i.id === active.id) ?? -1;
    const newIndex = column?.items.findIndex((i) => i.id === over.id) ?? -1;
    const next =
      oldIndex === -1 || newIndex === -1 || oldIndex === newIndex
        ? columns
        : columns.map((c) =>
            c.id === columnId ? { ...c, items: arrayMove(c.items, oldIndex, newIndex) } : c,
          );

    if (next !== committedColumns) onColumnsChange?.(next);
  }

  function handleDragCancel() {
    setActiveItem(null);
    setDraft(null);
  }

  if (readOnly) {
    return (
      <div className={cn("flex flex-1 gap-4 overflow-x-auto pb-2", className)} {...props}>
        {committedColumns.map((column) => (
          <section
            key={column.id}
            aria-label={column.title}
            className="flex w-72 shrink-0 flex-col gap-2 rounded-xl p-2"
          >
            <ColumnHeader column={column} />
            {column.items.map((item) => (
              <KanbanCard key={item.id} item={item} className="cursor-default" />
            ))}
          </section>
        ))}
      </div>
    );
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      <div className={cn("flex flex-1 gap-4 overflow-x-auto pb-2", className)} {...props}>
        {columns.map((column) => (
          <KanbanColumn key={column.id} column={column} />
        ))}
      </div>
      <DragOverlay>
        {activeItem && (
          <KanbanCard item={activeItem} className="rotate-2 cursor-grabbing shadow-lg" />
        )}
      </DragOverlay>
    </DndContext>
  );
}

function KanbanColumn({ column }: { column: IssueGroup }) {
  // The column itself is a drop target so empty columns can receive cards.
  const { setNodeRef, isOver } = useDroppable({ id: column.id });

  return (
    <section aria-label={column.title} className="flex w-72 shrink-0 flex-col gap-2 rounded-xl p-2">
      <ColumnHeader column={column} />
      <SortableContext items={column.items.map((i) => i.id)} strategy={verticalListSortingStrategy}>
        <div
          ref={setNodeRef}
          className={cn(
            "flex min-h-20 flex-1 flex-col gap-2 rounded-lg transition-colors",
            isOver && column.items.length === 0 && "bg-accent/50",
          )}
        >
          {column.items.map((item) => (
            <SortableKanbanCard key={item.id} item={item} />
          ))}
        </div>
      </SortableContext>
    </section>
  );
}

function ColumnHeader({ column }: { column: IssueGroup }) {
  return (
    <header className="flex min-h-7 items-center gap-2 px-1 pb-1">
      <span
        aria-hidden
        className={cn("size-2 shrink-0 rounded-full", column.color ?? "bg-muted-foreground")}
      />
      <h2 className="shrink-0 text-xs font-semibold tracking-tight">{column.title}</h2>
      <span className="rounded-full bg-foreground/5 px-2 py-0.5 font-mono text-[10px] leading-none text-muted-foreground ring-1 ring-foreground/10 tabular-nums">
        {column.items.length}
      </span>
      {column.source && (
        <span
          title={column.source.detail}
          className="ml-auto truncate font-mono text-[9px] text-muted-foreground"
        >
          {column.source.label}
        </span>
      )}
    </header>
  );
}

function SortableKanbanCard({ item }: { item: Issue }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.id,
  });

  return (
    <KanbanCard
      ref={setNodeRef}
      item={item}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      // The original stays in place as a faded placeholder while the overlay follows the pointer.
      className={cn("touch-none", isDragging && "opacity-40")}
      {...attributes}
      {...listeners}
    />
  );
}
