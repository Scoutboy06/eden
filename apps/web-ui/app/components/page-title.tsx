import { PaintBoardIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";

import { SettingsDialog } from "@/components/settings-dialog";
import { Button } from "@/components/ui/button";
import { SidebarTrigger } from "@/components/ui/sidebar";

export function PageTitle({ title }: { title?: string }) {
  const [settingsOpen, setSettingsOpen] = useState(false);

  return (
    <div className="flex items-center gap-2.5">
      <SidebarTrigger className="-ml-1.5 text-muted-foreground" />
      <h1 className="font-heading text-base font-bold">{title}</h1>
      <div className="ml-auto flex items-center gap-1 text-xs font-medium text-muted-foreground">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Appearance"
          title="Appearance"
          onClick={() => setSettingsOpen(true)}
        >
          <HugeiconsIcon icon={PaintBoardIcon} strokeWidth={2} />
        </Button>
      </div>
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </div>
  );
}
