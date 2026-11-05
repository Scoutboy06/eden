import { Outlet } from "react-router-dom";

import { ActivityBar } from "@/components/activity-bar";
import { TooltipProvider } from "@/components/ui/tooltip";

export function AppLayout() {
  return (
    <TooltipProvider>
      <div className="flex h-svh">
        <ActivityBar />
        <main className="flex min-w-0 flex-1 flex-col overflow-auto p-4">
          <Outlet />
        </main>
      </div>
    </TooltipProvider>
  );
}
