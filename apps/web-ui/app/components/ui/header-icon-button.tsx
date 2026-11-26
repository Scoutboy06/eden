import type { ComponentProps } from "react";
import { cn } from "cn";

import { Button } from "@/components/ui/button";

export function HeaderIconButton({
  label,
  className,
  ...props
}: Omit<ComponentProps<typeof Button>, "variant" | "size"> & { label: string }) {
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      className={cn("border-border/50 bg-transparent text-muted-foreground", className)}
      aria-label={label}
      title={label}
      {...props}
    />
  );
}
