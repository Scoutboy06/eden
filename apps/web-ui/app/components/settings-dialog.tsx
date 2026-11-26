import { Fragment, useState } from "react";

import { FlaskRoundIcon, PaintBoardIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import {
  updateThemeSettings,
  useThemeSettings,
  type ThemeSettings,
} from "@/settings/theme-settings";

import { themeCatalog } from "../../themes/catalog";

const modeOptions = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
] as const;

const categories = [
  { name: "Appearance", icon: PaintBoardIcon },
  { name: "Labs", icon: FlaskRoundIcon },
] as const;
type SettingsCategory = (typeof categories)[number]["name"];

export function SettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [category, setCategory] = useState<SettingsCategory>("Appearance");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(40rem,calc(100svh-2rem))] max-h-[calc(100svh-2rem)] max-w-3xl flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl">
        <DialogHeader className="sr-only">
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>Customize Eden settings.</DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-1">
          <aside className="hidden w-52 shrink-0 flex-col border-r bg-sidebar p-3 text-sidebar-foreground md:flex">
            <nav aria-label="Settings categories" className="flex flex-col gap-1">
              {categories.map((item) => (
                <CategoryButton
                  key={item.name}
                  category={item.name}
                  icon={item.icon}
                  selected={category === item.name}
                  onSelect={setCategory}
                />
              ))}
            </nav>
          </aside>
          <main className="flex min-h-0 min-w-0 flex-1 flex-col">
            <header className="flex h-14 shrink-0 items-center border-b px-4 sm:px-6">
              <div className="flex items-center gap-2 text-sm">
                <span className="text-muted-foreground">Settings</span>
                <span aria-hidden="true" className="text-muted-foreground">
                  /
                </span>
                <span className="font-medium">{category}</span>
              </div>
            </header>
            <nav
              aria-label="Settings categories"
              className="flex shrink-0 gap-1 overflow-x-auto border-b p-2 md:hidden"
            >
              {categories.map((item) => (
                <CategoryButton
                  key={item.name}
                  category={item.name}
                  icon={item.icon}
                  selected={category === item.name}
                  onSelect={setCategory}
                />
              ))}
            </nav>
            <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
              {category === "Appearance" ? <AppearanceSettings /> : <LabsSettings />}
            </div>
          </main>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function CategoryButton({
  category,
  icon,
  selected,
  onSelect,
}: {
  category: SettingsCategory;
  icon: typeof PaintBoardIcon;
  selected: boolean;
  onSelect: (category: SettingsCategory) => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      aria-current={selected ? "page" : undefined}
      onClick={() => onSelect(category)}
      className={`h-8 justify-start px-2.5 text-left ${
        selected ? "bg-muted text-foreground" : "text-muted-foreground"
      }`}
    >
      <HugeiconsIcon icon={icon} strokeWidth={2} />
      {category}
    </Button>
  );
}

function AppearanceSettings() {
  const settings = useThemeSettings();
  const controls = [
    {
      key: "navigationStyle",
      label: "Navigation",
      description: "Choose the classic activity rail or the shadcn sidebar-09 layout.",
      options: [
        { value: "classic", label: "Classic (recommended)" },
        { value: "sidebar-09", label: "Sidebar 09" },
      ],
    },
    {
      key: "mode",
      label: "Mode",
      description: "Use a light, dark, or system-controlled appearance.",
      options: modeOptions,
    },
    {
      key: "lightTheme",
      label: "Light theme",
      description: "Choose the recipe used in light mode.",
      options: themeCatalog.options,
    },
    {
      key: "darkTheme",
      label: "Dark theme",
      description: "Choose the recipe used in dark mode.",
      options: themeCatalog.options,
    },
  ] as const;

  return (
    <section aria-labelledby="appearance-heading" className="mx-auto w-full max-w-2xl">
      <div className="mb-5">
        <h2 id="appearance-heading" className="text-lg font-semibold">
          Appearance
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">Customize how Eden looks.</p>
      </div>
      <Card size="sm" className="shadow-2xs">
        <CardContent>
          <FieldGroup className="gap-3">
            {controls.map((control, index) => (
              <Fragment key={control.key}>
                {index > 0 && <Separator />}
                <SelectSetting
                  id={`setting-${control.key}`}
                  label={control.label}
                  description={control.description}
                  value={settings[control.key]}
                  options={control.options}
                  onChange={(value) =>
                    updateThemeSettings({ [control.key]: value } as Partial<ThemeSettings>)
                  }
                />
              </Fragment>
            ))}
          </FieldGroup>
        </CardContent>
      </Card>
    </section>
  );
}

function LabsSettings() {
  return (
    <section aria-labelledby="labs-heading" className="mx-auto w-full max-w-2xl">
      <div>
        <h2 id="labs-heading" className="text-lg font-semibold">
          Labs
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Experimental settings will appear here.
        </p>
      </div>
    </section>
  );
}

function SelectSetting({
  id,
  label,
  description,
  value,
  options,
  onChange,
}: {
  id: string;
  label: string;
  description: string;
  value: string;
  options: readonly { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  const selectedOption = options.find((option) => option.value === value);

  return (
    <Field orientation="responsive" className="@md/field-group:items-center!">
      <FieldContent>
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        <FieldDescription>{description}</FieldDescription>
      </FieldContent>
      <Select value={value} onValueChange={(next) => next !== null && onChange(next)}>
        <SelectTrigger id={id} className="w-full md:w-44">
          <SelectValue>{selectedOption?.label}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </Field>
  );
}
