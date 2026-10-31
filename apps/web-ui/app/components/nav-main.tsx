import { HugeiconsIcon } from "@hugeicons/react";
import { Link, useLocation } from "react-router-dom";
import { cn } from "cn";

import {
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import type { NavigationItem } from "@/navigation";

const badgeTones = {
  attention:
    "bg-attention text-attention-foreground peer-hover/menu-button:text-attention-foreground peer-data-active/menu-button:text-attention-foreground",
  destructive:
    "bg-destructive text-destructive-foreground peer-hover/menu-button:text-destructive-foreground peer-data-active/menu-button:text-destructive-foreground",
} as const;

export function NavMain({ items }: { items: readonly NavigationItem[] }) {
  const { pathname } = useLocation();

  return (
    <SidebarMenu>
      {items.map((item) => (
        <SidebarMenuItem key={item.href}>
          <SidebarMenuButton
            render={<Link to={item.href} />}
            tooltip={item.title}
            isActive={pathname === item.href}
          >
            <HugeiconsIcon icon={item.icon} strokeWidth={2} />
            <span>{item.title}</span>
          </SidebarMenuButton>
          {item.badge && (
            <SidebarMenuBadge className={cn("rounded-full font-mono", badgeTones[item.badge.tone])}>
              {item.badge.count}
            </SidebarMenuBadge>
          )}
        </SidebarMenuItem>
      ))}
    </SidebarMenu>
  );
}
