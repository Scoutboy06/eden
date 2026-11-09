import type { ComponentProps } from "react";
import { cn } from "cn";

import { Button } from "@/components/ui/button";

type HeaderIconButtonProps = Omit<ComponentProps<typeof Button>, "variant" | "size"> & {
  label: string;
};

export function HeaderIconButton({ label, className, ...props }: HeaderIconButtonProps) {
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      className={cn(
        "cursor-pointer border-border/50 bg-transparent text-muted-foreground",
        className,
      )}
      aria-label={label}
      title={label}
      {...props}
    />
  );
}
