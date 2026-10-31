import { useState } from "react";

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { projects } from "@/navigation";

export function ProjectSelect() {
  const [project, setProject] = useState<string>(projects[0]);

  return (
    <Select value={project} onValueChange={(next) => next !== null && setProject(next)}>
      <SelectTrigger
        aria-label="Project"
        className="w-full bg-sidebar-accent text-sidebar-accent-foreground group-data-[collapsible=icon]:hidden"
      >
        <SelectValue>{project}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {projects.map((name) => (
            <SelectItem key={name} value={name}>
              {name}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}
