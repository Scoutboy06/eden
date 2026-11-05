import { Select as SelectPrimitive } from "@base-ui/react/select";
import { cn } from "cn";
import { useState } from "react";

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
} from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { projects } from "@/navigation";

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
  const [project, setProject] = useState<string>(projects[0]);

  return (
    <Select value={project} onValueChange={(next) => next !== null && setProject(next)}>
      <Tooltip>
        <TooltipTrigger
          render={
            <SelectPrimitive.Trigger
              aria-label={`Project: ${project}`}
              className="flex size-12 items-center justify-center outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
            />
          }
        >
          <ProjectTile
            name={project}
            className="transition-shadow hover:ring-2 hover:ring-ring/50"
          />
        </TooltipTrigger>
        <TooltipContent side="right">{project}</TooltipContent>
      </Tooltip>
      <SelectContent side="right" align="start" alignItemWithTrigger={false} className="min-w-52">
        <SelectGroup>
          <SelectLabel>Projects</SelectLabel>
          {projects.map((name) => (
            <SelectItem key={name} value={name}>
              <ProjectTile name={name} className="size-5 rounded text-[0.6rem]" />
              {name}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}
