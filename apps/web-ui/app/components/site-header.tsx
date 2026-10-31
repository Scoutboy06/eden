import { PaintBoardIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";

import { SettingsDialog } from "@/components/settings-dialog";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";

export function SiteHeader({ heading = "Eden" }: { heading?: string }) {
  const [settingsOpen, setSettingsOpen] = useState(false);

  return (
    <header className="flex h-(--header-height) shrink-0 items-center border-b transition-[width,height] ease-linear">
      <div className="flex w-full items-center gap-1 px-4 lg:gap-2 lg:px-6">
        <SidebarTrigger className="-ml-1" />
        <Separator orientation="vertical" className="mx-2 h-4 data-vertical:self-auto" />
        <h1 className="text-base font-medium">{heading}</h1>
        <Button
          variant="ghost"
          size="icon"
          className="ml-auto"
          aria-label="Appearance"
          title="Appearance"
          onClick={() => setSettingsOpen(true)}
        >
          <HugeiconsIcon icon={PaintBoardIcon} strokeWidth={2} />
        </Button>
        <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
      </div>
    </header>
  );
}
