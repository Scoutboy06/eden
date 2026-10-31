import type { CSSProperties } from "react";
import { Outlet, useLocation } from "react-router-dom";

import { AppSidebar } from "@/components/app-sidebar";
import { SiteHeader } from "@/components/site-header";
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
            "--sidebar-width": "calc(var(--spacing) * 40)",
            "--header-height": "calc(var(--spacing) * 12)",
          } as CSSProperties
        }
      >
        <AppSidebar />
        <SidebarInset>
          <SiteHeader heading={heading} />
          <main className="flex flex-1 flex-col p-4 lg:p-6">
            <Outlet />
          </main>
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  );
}
