import type { CSSProperties } from "react";
import { Outlet, useLocation } from "react-router-dom";

import { AppSidebar } from "@/components/app-sidebar";
import { PageTitle } from "@/components/page-title";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { navigation } from "@/navigation";

export function AppLayout() {
  const { pathname } = useLocation();
  const heading = navigation.find((item) => item.href === pathname)?.title;

  return (
    <TooltipProvider>
      <SidebarProvider
        style={
          {
            "--sidebar-width": "calc(var(--spacing) * 64)",
          } as CSSProperties
        }
      >
        <AppSidebar />
        <SidebarInset>
          <main className="flex flex-1 flex-col gap-2.5 p-4 lg:p-6">
            <PageTitle title={heading} />
            <Outlet />
          </main>
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  );
}
