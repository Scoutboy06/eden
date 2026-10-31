import {
  GitBranchIcon,
  GitPullRequestIcon,
  InboxIcon,
  KanbanIcon,
  PulseIcon,
} from "@hugeicons/core-free-icons";
import type { ComponentType } from "react";

import { AsksPage } from "@/pages/AsksPage";
import { BoardPage } from "@/pages/BoardPage";
import { DoingPage } from "@/pages/DoingPage";
import { HealthPage } from "@/pages/HealthPage";
import { InReviewPage } from "@/pages/InReviewPage";

export interface NavigationItem {
  title: string;
  href: string;
  icon: typeof KanbanIcon;
  Page: ComponentType;
  /** Items pinned below the divider at the bottom of the sidebar. */
  bottom?: boolean;
  badge?: { count: number; tone: "attention" | "destructive" };
}

export const navigation: readonly NavigationItem[] = [
  { title: "Board", href: "/", icon: KanbanIcon, Page: BoardPage },
  { title: "Doing", href: "/doing", icon: GitBranchIcon, Page: DoingPage },
  { title: "In review", href: "/review", icon: GitPullRequestIcon, Page: InReviewPage },
  {
    title: "Asks",
    href: "/asks",
    icon: InboxIcon,
    Page: AsksPage,
    bottom: true,
    badge: { count: 2, tone: "attention" },
  },
  {
    title: "Health",
    href: "/health",
    icon: PulseIcon,
    Page: HealthPage,
    bottom: true,
    badge: { count: 1, tone: "destructive" },
  },
];

export const projects = ["Inet.Server", "Webshop", "Tooling"] as const;
