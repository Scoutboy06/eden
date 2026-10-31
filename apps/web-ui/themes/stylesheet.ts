import type { ThemeCatalog } from "./catalog";
import type { ThemeRecipe } from "./theme-definition";

const fontVariableNames = new Set(["font-sans", "font-serif", "font-mono"]);

export function generateThemeStylesheet(
  catalog: ThemeCatalog,
  lightId: string,
  darkId: string,
): string {
  const defaultRecipe = catalog.require("default");
  const lightRecipe = catalog.require(lightId);
  const darkRecipe = catalog.require(darkId);
  const imports = stylesheetImports([lightRecipe, darkRecipe]);

  return [
    ...imports.map((url) => `@import url("${url}");`),
    renderRule(":root:root", completeVariables(defaultRecipe, lightRecipe, "light")),
    renderRule(".dark.dark", completeVariables(defaultRecipe, darkRecipe, "dark")),
  ].join("\n");
}

function completeVariables(
  defaults: ThemeRecipe,
  selected: ThemeRecipe,
  mode: "light" | "dark",
): Record<string, string> {
  return { ...defaults.shared, ...defaults[mode], ...selected.shared, ...selected[mode] };
}

function stylesheetImports(recipes: readonly ThemeRecipe[]): string[] {
  return [
    ...new Set(
      recipes.flatMap((recipe) => {
        const local = recipe.fontStylesheets?.local ?? [];
        return local.length ? local : (recipe.fontStylesheets?.cdn ?? []);
      }),
    ),
  ];
}

function renderRule(selector: string, variables: Readonly<Record<string, string>>): string {
  const declarations = Object.entries(variables)
    .map(([name, value]) => `  --${cssVariableName(name)}: ${value};`)
    .join("\n");
  return `${selector} {\n${declarations}\n}`;
}

function cssVariableName(name: string): string {
  return fontVariableNames.has(name) ? `recipe-${name}` : name;
}
