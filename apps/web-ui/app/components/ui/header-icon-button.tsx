import type { ComponentProps } from "react";

import { Button } from "@/components/ui/button";

type HeaderIconButtonProps = Omit<ComponentProps<typeof Button>, "variant" | "size"> & {
  label: string;
};

export function HeaderIconButton({ label, ...props }: HeaderIconButtonProps) {
  return <Button variant="outline" size="icon-sm" aria-label={label} title={label} {...props} />;
}
