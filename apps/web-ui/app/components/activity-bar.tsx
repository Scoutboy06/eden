import { Settings01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { cn } from "cn";
import { useState, type ReactElement } from "react";
import { Link, useLocation } from "react-router-dom";

import { ProjectSelect } from "@/components/project-select";
import { SettingsDialog } from "@/components/settings-dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { navigation, type NavigationItem } from "@/navigation";

const topItems = navigation.filter((item) => !item.bottom);
const bottomItems = navigation.filter((item) => item.bottom);

/** Compact, icon-only navigation rail in the style of VS Code's activity bar. */
export function ActivityBar() {
  return (
    <nav
      aria-label="Main"
      className="flex h-svh w-12 shrink-0 flex-col items-center justify-between border-r bg-sidebar py-1 text-sidebar-foreground"
    >
      <div className="flex flex-col items-center">
        <ProjectSelect />
        <div className="mb-1 h-px w-6 bg-border" />
        <ActivityBarGroup items={topItems} />
      </div>
      <div className="flex flex-col">
        <ActivityBarGroup items={bottomItems} />
        <SettingsButton />
      </div>
    </nav>
  );
}

function ActivityBarGroup({ items }: { items: readonly NavigationItem[] }) {
  const { pathname } = useLocation();

  return (
    <ul className="flex flex-col">
      {items.map((item) => {
        const active = pathname === item.href;
        return (
          <li key={item.href}>
            <ActivityBarItem
              title={item.title}
              icon={item.icon}
              active={active}
              render={<Link to={item.href} aria-current={active ? "page" : undefined} />}
            />
          </li>
        );
      })}
    </ul>
  );
}

function SettingsButton() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <ActivityBarItem
        title="Settings"
        icon={Settings01Icon}
        active={open}
        render={<button type="button" onClick={() => setOpen(true)} />}
      />
      <SettingsDialog open={open} onOpenChange={setOpen} />
    </>
  );
}

function ActivityBarItem({
  title,
  icon,
  active,
  render,
}: {
  title: string;
  icon: NavigationItem["icon"];
  active: boolean;
  render: ReactElement;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        aria-label={title}
        render={render}
        className={cn(
          "relative flex size-12 items-center justify-center text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
          active &&
            "text-foreground before:absolute before:inset-y-2 before:left-0 before:w-0.5 before:bg-primary",
        )}
      >
        <HugeiconsIcon icon={icon} strokeWidth={2} className="size-6" />
      </TooltipTrigger>
      <TooltipContent side="right">{title}</TooltipContent>
    </Tooltip>
  );
}
