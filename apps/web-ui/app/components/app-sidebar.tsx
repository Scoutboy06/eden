import type { ComponentProps } from "react";

import { NavMain } from "@/components/nav-main";
import { ProjectSelect } from "@/components/project-select";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarHeader,
  SidebarSeparator,
} from "@/components/ui/sidebar";
import { navigation } from "@/navigation";

const topItems = navigation.filter((item) => !item.bottom);
const bottomItems = navigation.filter((item) => item.bottom);

export function AppSidebar(props: ComponentProps<typeof Sidebar>) {
  return (
    <Sidebar collapsible="icon" {...props}>
      <SidebarHeader>
        <ProjectSelect />
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup className="py-0">
          <NavMain items={topItems} />
        </SidebarGroup>
        <SidebarSeparator className="mt-auto" />
        <SidebarGroup>
          <NavMain items={bottomItems} />
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  );
}
