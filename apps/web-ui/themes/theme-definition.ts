export interface ThemeFontStylesheets {
  local?: readonly string[];
  cdn?: readonly string[];
}

export interface ThemeRecipe {
  id: string;
  name: string;
  shared: Readonly<Record<string, string>>;
  light: Readonly<Record<string, string>>;
  dark: Readonly<Record<string, string>>;
  fontStylesheets?: ThemeFontStylesheets;
}

export interface ThemeOption {
  value: string;
  label: string;
}

const themeIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const variableNamePattern = /^[a-z][a-z0-9-]*$/;
const unsafeCssValuePattern = /[;{}@\r\n]|\/\*|\*\/|url\s*\(/i;
const allowedVariableNames = new Set([
  "accent",
  "accent-foreground",
  "attention",
  "attention-foreground",
  "background",
  "border",
  "card",
  "card-foreground",
  "chart-1",
  "chart-2",
  "chart-3",
  "chart-4",
  "chart-5",
  "destructive",
  "destructive-foreground",
  "font-mono",
  "font-sans",
  "font-serif",
  "foreground",
  "input",
  "letter-spacing",
  "muted",
  "muted-foreground",
  "popover",
  "popover-foreground",
  "primary",
  "primary-foreground",
  "radius",
  "ring",
  "secondary",
  "secondary-foreground",
  "settings-pane",
  "shadow",
  "shadow-2xl",
  "shadow-2xs",
  "shadow-blur",
  "shadow-color",
  "shadow-lg",
  "shadow-md",
  "shadow-offset-x",
  "shadow-offset-y",
  "shadow-opacity",
  "shadow-sm",
  "shadow-spread",
  "shadow-xl",
  "shadow-xs",
  "sidebar",
  "sidebar-accent",
  "sidebar-accent-foreground",
  "sidebar-border",
  "sidebar-foreground",
  "sidebar-primary",
  "sidebar-primary-foreground",
  "sidebar-ring",
  "spacing",
  "tracking-normal",
  "tracking-tight",
  "tracking-tighter",
  "tracking-wide",
  "tracking-wider",
  "tracking-widest",
]);

export function validateThemeRecipe(value: unknown): ThemeRecipe {
  if (!isRecord(value)) throw new Error("Theme recipe must be an object");
  if (typeof value.id !== "string" || !themeIdPattern.test(value.id)) {
    throw new Error("Theme ID must contain lowercase letters, numbers, and single hyphens");
  }
  if (typeof value.name !== "string" || !value.name.trim()) {
    throw new Error("Theme name must not be empty");
  }

  const recipe: ThemeRecipe = {
    id: value.id,
    name: value.name.trim(),
    shared: validateVariables(value.shared, "shared"),
    light: validateVariables(value.light, "light"),
    dark: validateVariables(value.dark, "dark"),
  };
  if (!Object.keys(recipe.light).length || !Object.keys(recipe.dark).length) {
    throw new Error("Theme recipes require light and dark variables");
  }
  if (value.fontStylesheets !== undefined) {
    recipe.fontStylesheets = validateFontStylesheets(value.fontStylesheets);
  }
  return Object.freeze(recipe);
}

function validateVariables(value: unknown, group: string): Readonly<Record<string, string>> {
  if (!isRecord(value)) throw new Error(`Theme ${group} variables must be an object`);
  return Object.freeze(
    Object.fromEntries(
      Object.entries(value).map(([name, cssValue]) => {
        if (!variableNamePattern.test(name) || !allowedVariableNames.has(name)) {
          throw new Error(`Unsupported theme variable: ${name}`);
        }
        if (typeof cssValue !== "string" || !cssValue.trim()) {
          throw new Error(`Theme variable ${name} must have a value`);
        }
        if (unsafeCssValuePattern.test(cssValue) || !hasBalancedQuotes(cssValue)) {
          throw new Error(`Theme variable ${name} contains unsafe CSS`);
        }
        return [name, cssValue.trim()];
      }),
    ),
  );
}

function validateFontStylesheets(value: unknown): ThemeFontStylesheets {
  if (!isRecord(value)) throw new Error("fontStylesheets must be an object");
  const local = validateStylesheetList(
    value.local,
    "local",
    (url) => isSafeStylesheetUrl(url) && url.startsWith("/") && !url.startsWith("//"),
  );
  const cdn = validateStylesheetList(value.cdn, "CDN", (url) => {
    try {
      return isSafeStylesheetUrl(url) && new URL(url).protocol === "https:";
    } catch {
      return false;
    }
  });
  return Object.freeze({ ...(local.length && { local }), ...(cdn.length && { cdn }) });
}

function validateStylesheetList(
  value: unknown,
  source: string,
  accepts: (url: string) => boolean,
): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((url) => typeof url !== "string" || !accepts(url))) {
    throw new Error(`Theme ${source} font stylesheets contain an invalid URL`);
  }
  return Object.freeze([...new Set(value)]);
}

function hasBalancedQuotes(value: string): boolean {
  for (const quote of ['"', "'"]) {
    let count = 0;
    for (let index = 0; index < value.length; index++) {
      if (value[index] === quote && value[index - 1] !== "\\") count++;
    }
    if (count % 2 !== 0) return false;
  }
  return true;
}

function isSafeStylesheetUrl(value: string): boolean {
  return !/[\s"'()\\]/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
