import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useRef } from "react";

export function useVirtualList<T extends { id: string }>({
  items,
  estimateSize,
  overscan = 8,
}: {
  items: T[];
  estimateSize: number;
  overscan?: number;
}) {
  const scrollElement = useRef<HTMLDivElement>(null);
  const getItemKey = useCallback((index: number) => items[index]!.id, [items]);
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollElement.current,
    estimateSize: () => estimateSize,
    getItemKey,
    overscan,
    initialRect: { width: 800, height: 600 },
  });

  return { scrollElement, virtualizer };
}
