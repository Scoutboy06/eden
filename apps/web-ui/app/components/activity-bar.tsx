import { Settings01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { cn } from "cn";
import { useState, type ReactElement } from "react";
import { Link, useLocation, useParams } from "react-router-dom";

import { ProjectSelect } from "@/components/project-select";
import { SettingsDialog } from "@/components/settings-dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { navigation, type NavigationItem } from "@/navigation";
import { useThemeSettings } from "@/settings/theme-settings";

const topItems = navigation.filter((item) => !item.bottom);
const bottomItems = navigation.filter((item) => item.bottom);

/** Compact, icon-only navigation rail in the style of VS Code's activity bar. */
export function ActivityBar() {
  const { navigationStyle } = useThemeSettings();
  const sidebar09 = navigationStyle === "sidebar-09";

  return (
    <nav
      aria-label="Main"
      className={`flex h-svh w-12 shrink-0 border-r bg-sidebar text-sidebar-foreground ${
        sidebar09 ? "border-sidebar-border" : ""
      }`}
    >
      <div className="flex h-full min-w-12 flex-col items-center justify-between py-1">
        <div className="flex flex-col items-center">
          <ProjectSelect compact={sidebar09} />
          <div className="mb-1 h-px w-6 bg-border" />
          <ActivityBarGroup items={topItems} sidebar09={sidebar09} />
        </div>
        <div className="flex flex-col">
          <ActivityBarGroup items={bottomItems} sidebar09={sidebar09} />
          <SettingsButton sidebar09={sidebar09} />
        </div>
      </div>
    </nav>
  );
}

function ActivityBarGroup({
  items,
  sidebar09,
}: {
  items: readonly NavigationItem[];
  sidebar09: boolean;
}) {
  const { pathname } = useLocation();
  const { project } = useParams();

  return (
    <ul className="flex flex-col">
      {items.map((item) => {
        const href = `/p/${encodeURIComponent(project ?? "")}${item.href ? `/${item.href}` : ""}`;
        const active = pathname === href;
        return (
          <li key={item.href}>
            <ActivityBarItem
              title={item.title}
              icon={item.icon}
              active={active}
              sidebar09={sidebar09}
              render={<Link to={href} aria-current={active ? "page" : undefined} />}
            />
          </li>
        );
      })}
    </ul>
  );
}

function SettingsButton({ sidebar09 }: { sidebar09: boolean }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <ActivityBarItem
        title="Settings"
        icon={Settings01Icon}
        active={open}
        sidebar09={sidebar09}
        render={
          <button
            type="button"
            aria-haspopup="dialog"
            aria-expanded={open}
            onClick={() => setOpen(true)}
          />
        }
      />
      <SettingsDialog open={open} onOpenChange={setOpen} />
    </>
  );
}

function ActivityBarItem({
  title,
  icon,
  active,
  sidebar09,
  render,
}: {
  title: string;
  icon: NavigationItem["icon"];
  active: boolean;
  sidebar09: boolean;
  render: ReactElement;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        aria-label={title}
        render={render}
        className={cn(
          sidebar09
            ? "relative flex size-10 items-center justify-center rounded-md text-muted-foreground transition-colors outline-none hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
            : "relative flex size-12 items-center justify-center text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
          active &&
            (sidebar09
              ? "bg-sidebar-accent text-sidebar-accent-foreground before:absolute before:inset-y-2 before:left-0 before:w-0.5 before:rounded-r-full before:bg-sidebar-primary"
              : "text-foreground before:absolute before:inset-y-2 before:left-0 before:w-0.5 before:bg-primary"),
        )}
      >
        <HugeiconsIcon icon={icon} strokeWidth={2} className={sidebar09 ? "size-5" : "size-6"} />
      </TooltipTrigger>
      <TooltipContent side="right">{title}</TooltipContent>
    </Tooltip>
  );
}
