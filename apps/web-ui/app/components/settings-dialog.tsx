import { Fragment } from "react";

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

export function SettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const settings = useThemeSettings();
  const controls = [
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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Appearance</DialogTitle>
          <DialogDescription>Customize how Eden looks.</DialogDescription>
        </DialogHeader>
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
      </DialogContent>
    </Dialog>
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
