import { Add01Icon, Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useId, useState } from "react";

import type { IssueGroup } from "@/components/issue/issue";
import { LabelsInput } from "@/components/issue/task-detail-panel";
import { Button } from "@/components/ui/button";
import { HeaderIconButton } from "@/components/ui/header-icon-button";
import {
  Combobox,
  ComboboxContent,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectLabel,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

export function CreateTaskPrototypes({ groups }: { groups: IssueGroup[] }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [type, setType] = useState<string | null>("task");
  const [priority, setPriority] = useState<string | null>("2");
  const [assignee, setAssignee] = useState("");
  const [labels, setLabels] = useState<string[]>([]);
  const [deferred, setDeferred] = useState(false);
  const id = useId();
  const tasks = groups.flatMap((group) => group.items);
  const assignees = [
    ...new Set(tasks.flatMap((task) => (task.assignee ? [task.assignee.name] : []))),
  ].sort();
  const labelSuggestions = [...new Set(tasks.flatMap((task) => task.labels ?? []))].sort();

  return (
    <Dialog>
      <DialogTrigger render={<Button size="lg" className="px-3.5" />}>
        <HugeiconsIcon icon={Add01Icon} strokeWidth={2} aria-hidden="true" />
        New task
      </DialogTrigger>
      <DialogContent
        showCloseButton={false}
        className="max-h-[90svh] overflow-y-auto gap-0 p-0 sm:max-w-xl"
      >
        <header className="flex items-center justify-between gap-4 border-b border-border p-4">
          <div className="space-y-2">
            <DialogTitle>New task</DialogTitle>
            <DialogDescription className="text-xs">
              Design preview · No tasks will be created.
            </DialogDescription>
          </div>
          <DialogClose render={<HeaderIconButton label="Close new task" />}>
            <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} aria-hidden />
          </DialogClose>
        </header>
        <div className="space-y-5 p-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label id={`${id}-type`} className="text-xs text-muted-foreground">
                Type
              </Label>
              <Select value={type} onValueChange={setType}>
                <SelectTrigger aria-labelledby={`${id}-type`} className="w-full bg-muted/40">
                  <span className="capitalize">{type}</span>
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectLabel>Task type</SelectLabel>
                    <SelectItem value="task">Task</SelectItem>
                    <SelectItem value="bug">Bug</SelectItem>
                    <SelectItem value="feature">Feature</SelectItem>
                    <SelectItem value="chore">Chore</SelectItem>
                    <SelectItem value="epic">Epic</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label id={`${id}-priority`} className="text-xs text-muted-foreground">
                Priority
              </Label>
              <Select value={priority} onValueChange={setPriority}>
                <SelectTrigger aria-labelledby={`${id}-priority`} className="w-full bg-muted/40">
                  P{priority}
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectLabel>Priority</SelectLabel>
                    {[0, 1, 2, 3, 4].map((value) => (
                      <SelectItem key={value} value={String(value)}>
                        P{value}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor={`${id}-title`} className="text-xs text-muted-foreground">
              Title
            </Label>
            <Input
              id={`${id}-title`}
              value={title}
              required
              maxLength={500}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="What needs to be done?"
              className="h-auto bg-muted/40 py-2 text-xl font-semibold"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={`${id}-description`} className="text-xs text-muted-foreground">
              Description
            </Label>
            <Textarea
              id={`${id}-description`}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Add context, requirements, or a definition of done…"
              rows={8}
              className="min-h-40 resize-y bg-muted/40"
            />
          </div>
          <div className="space-y-2">
            <Label id={`${id}-assignee`} className="text-xs text-muted-foreground">
              Assignee
            </Label>
            <Combobox
              items={assignees}
              inputValue={assignee}
              onInputValueChange={setAssignee}
              value={assignee || null}
              onValueChange={(value) => setAssignee(value ?? "")}
            >
              <ComboboxInput
                aria-labelledby={`${id}-assignee`}
                placeholder="Unassigned"
                className="w-full bg-muted/40"
              />
              <ComboboxContent>
                <ComboboxList>
                  {(name: string) => (
                    <ComboboxItem key={name} value={name}>
                      {name}
                    </ComboboxItem>
                  )}
                </ComboboxList>
              </ComboboxContent>
            </Combobox>
          </div>
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">Labels</p>
            <LabelsInput value={labels} suggestions={labelSuggestions} onChange={setLabels} />
          </div>
          <label className="flex cursor-pointer items-start gap-2.5 text-xs leading-5">
            <input
              type="checkbox"
              checked={deferred}
              onChange={(event) => setDeferred(event.target.checked)}
              className="mt-0.5 size-4 shrink-0 accent-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            />
            Start in Backlog (deferred) instead of Ready
          </label>
        </div>
        <footer className="flex justify-end gap-2 border-t border-border p-4">
          <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
          <Button disabled title="Design preview only; task creation is not connected">
            Create task
          </Button>
        </footer>
      </DialogContent>
    </Dialog>
  );
}
