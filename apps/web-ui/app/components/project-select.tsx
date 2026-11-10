import { Add01Icon, Delete02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import { ImportProject } from "@/components/import-project";
import { DeleteProject } from "@/components/delete-project";
import type { Project } from "@/pages/projects";
import { cn } from "cn";
import { useNavigate, useParams } from "react-router-dom";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useProjects } from "@/pages/use-projects";

/** Initials from the project name's words: "Inet.Server" → "IS", "Webshop" → "WE". */
function monogram(name: string) {
  const words = name.split(/[^\p{L}\p{N}]+|(?<=\p{Ll})(?=\p{Lu})/u).filter(Boolean);
  const [first, second] = words;
  const letters = first && second ? first.charAt(0) + second.charAt(0) : name.slice(0, 2);
  return letters.toUpperCase();
}

/** A stable hue per project, so each one is recognisable at a glance. */
function hue(name: string) {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return Math.abs(hash) % 360;
}

function ProjectTile({ name, className }: { name: string; className?: string }) {
  return (
    <span
      aria-hidden
      style={{ backgroundColor: `oklch(0.6 0.14 ${hue(name)})` }}
      className={cn(
        "flex size-8 shrink-0 items-center justify-center rounded-md font-mono text-xs font-bold text-white",
        className,
      )}
    >
      {monogram(name)}
    </span>
  );
}

export function ProjectSelect() {
  const { project: key = "" } = useParams();
  const navigate = useNavigate();
  const [importOpen, setImportOpen] = useState(false);
  const [removing, setRemoving] = useState<Project | null>(null);
  const { projects } = useProjects();
  const project = projects?.find((item) => item.key === key);

  if (!project) return null;

  return (
    <>
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger
            render={
              <DropdownMenuTrigger
                aria-label={`Project: ${project.name}`}
                className="flex size-12 items-center justify-center outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
              />
            }
          >
            <ProjectTile
              name={project.name}
              className="transition-shadow hover:ring-2 hover:ring-ring/50"
            />
          </TooltipTrigger>
          <TooltipContent side="right">{project.name}</TooltipContent>
        </Tooltip>
        <DropdownMenuContent side="right" align="start" className="min-w-52">
          <div className="px-1.5 py-1 text-xs text-muted-foreground">Projects</div>
          {projects?.map(({ key: projectKey, name }) => (
            <div key={projectKey} className="group flex items-center">
              <DropdownMenuItem
                className="flex-1"
                onClick={() => navigate(`/p/${encodeURIComponent(projectKey)}`)}
                aria-current={projectKey === key ? "page" : undefined}
              >
                <ProjectTile name={name} className="size-5 rounded text-[0.6rem]" />
                {name}
              </DropdownMenuItem>
              <DropdownMenuItem
                aria-label={`Remove ${name}`}
                title={`Remove ${name}`}
                onClick={() => setRemoving({ key: projectKey, name })}
                className="text-muted-foreground hover:text-destructive data-highlighted:opacity-100 focus:opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100"
              >
                <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
              </DropdownMenuItem>
            </div>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setImportOpen(true)}>
            <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
            Import project
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ImportProject open={importOpen} onOpenChange={setImportOpen} />
      <DeleteProject project={removing} onClose={() => setRemoving(null)} />
    </>
  );
}
