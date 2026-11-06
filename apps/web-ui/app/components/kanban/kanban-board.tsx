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

import { KanbanCard, type KanbanItem } from "./kanban-card";

export type KanbanColumnData = {
  id: string;
  title: string;
  items: KanbanItem[];
};

type KanbanBoardProps = Omit<React.ComponentProps<"div">, "onChange"> & {
  /** Initial columns; the board keeps its own state after mount. */
  columns: KanbanColumnData[];
  /** Called with the new layout after a card is dropped. */
  onColumnsChange?: (columns: KanbanColumnData[]) => void;
};

/** Id of the column containing `id`, where `id` is a card or a column. */
function findColumnId(columns: KanbanColumnData[], id: string) {
  if (columns.some((column) => column.id === id)) return id;
  return columns.find((column) => column.items.some((item) => item.id === id))?.id;
}

export function KanbanBoard({
  columns: initialColumns,
  onColumnsChange,
  className,
  ...props
}: KanbanBoardProps) {
  const [columns, setColumns] = useState(initialColumns);
  const [activeItem, setActiveItem] = useState<KanbanItem | null>(null);
  // Snapshot to restore if the drag is cancelled after crossing columns.
  const [dragStartColumns, setDragStartColumns] = useState<KanbanColumnData[] | null>(null);

  const sensors = useSensors(
    // Small distance so clicks on a card still register as clicks.
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function handleDragStart({ active }: DragStartEvent) {
    const item = columns.flatMap((column) => column.items).find((i) => i.id === active.id);
    setActiveItem(item ?? null);
    setDragStartColumns(columns);
  }

  // Move the card into another column while hovering, so that column makes room for it.
  function handleDragOver({ active, over }: DragOverEvent) {
    if (!over) return;
    const fromId = findColumnId(columns, String(active.id));
    const toId = findColumnId(columns, String(over.id));
    if (!fromId || !toId || fromId === toId) return;

    setColumns((prev) => {
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
    setDragStartColumns(null);
    if (!over) return;

    const columnId = findColumnId(columns, String(active.id));
    const column = columns.find((c) => c.id === columnId);
    if (!column) return;

    const oldIndex = column.items.findIndex((i) => i.id === active.id);
    const newIndex = column.items.findIndex((i) => i.id === over.id);
    const next =
      newIndex === -1 || oldIndex === newIndex
        ? columns
        : columns.map((c) =>
            c.id === columnId ? { ...c, items: arrayMove(c.items, oldIndex, newIndex) } : c,
          );

    setColumns(next);
    onColumnsChange?.(next);
  }

  function handleDragCancel() {
    if (dragStartColumns) setColumns(dragStartColumns);
    setActiveItem(null);
    setDragStartColumns(null);
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

function KanbanColumn({ column }: { column: KanbanColumnData }) {
  // The column itself is a drop target so empty columns can receive cards.
  const { setNodeRef, isOver } = useDroppable({ id: column.id });

  return (
    <section
      aria-label={column.title}
      className="flex w-72 shrink-0 flex-col gap-2 rounded-xl bg-muted/50 p-2"
    >
      <header className="flex items-center justify-between px-1 py-0.5">
        <h2 className="text-sm font-medium">{column.title}</h2>
        <span className="text-xs text-muted-foreground tabular-nums">{column.items.length}</span>
      </header>
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

function SortableKanbanCard({ item }: { item: KanbanItem }) {
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
