import {
  GitBranchIcon,
  GitPullRequestIcon,
  KanbanIcon,
  PulseIcon,
} from "@hugeicons/core-free-icons";
import type { ComponentType } from "react";

import { BoardPage } from "@/pages/BoardPage";
import { DoingPage } from "@/pages/DoingPage";
import { HealthPage } from "@/pages/HealthPage";
import { PRsPage } from "@/pages/PRsPage";

export interface NavigationItem {
  title: string;
  href: string;
  icon: typeof KanbanIcon;
  Page: ComponentType;
  /** Items pinned to the bottom of the activity bar. */
  bottom?: boolean;
}

export const navigation: readonly NavigationItem[] = [
  { title: "Board", href: "/", icon: KanbanIcon, Page: BoardPage },
  { title: "Doing", href: "/doing", icon: GitBranchIcon, Page: DoingPage },
  { title: "PRs", href: "/prs", icon: GitPullRequestIcon, Page: PRsPage },
  { title: "Health", href: "/health", icon: PulseIcon, Page: HealthPage, bottom: true },
];

export const projects = ["Inet.Server", "Webshop", "Tooling"] as const;
