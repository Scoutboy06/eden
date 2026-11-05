/// <reference types="bun" />

import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { validateThemeRecipe } from "../themes/theme-definition";

interface ImportOptions {
  id: string;
  name: string;
  registryUrl: string;
  update: boolean;
  cdnFonts: string[];
  localFonts: string[];
}

const recipesDirectory = join(import.meta.dir, "../themes/recipes");

async function main() {
  const options = parseOptions(Bun.argv.slice(2));
  const registry = await fetchRegistryItem(options.registryUrl);
  const cssVars = readCssVariables(registry);
  const recipe = validateThemeRecipe({
    id: options.id,
    name: options.name,
    shared: cssVars.theme ?? {},
    light: cssVars.light,
    dark: cssVars.dark,
    ...((options.localFonts.length || options.cdnFonts.length) && {
      fontStylesheets: {
        ...(options.localFonts.length && { local: options.localFonts }),
        ...(options.cdnFonts.length && { cdn: options.cdnFonts }),
      },
    }),
  });

  const recipePath = join(recipesDirectory, `${recipe.id}.json`);
  if (!options.update && (await Bun.file(recipePath).exists())) {
    throw new Error(`Theme ${recipe.id} already exists; pass --update to replace it`);
  }
  await writeFile(recipePath, `${JSON.stringify(recipe, null, 2)}\n`);
  console.log(`Imported ${recipe.name} as ${recipe.id}; restart the server to load it`);
}

function parseOptions(args: string[]): ImportOptions {
  const values = new Map<string, string>();
  const cdnFonts: string[] = [];
  const localFonts: string[] = [];
  let update = false;
  let registryUrl: string | undefined;

  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (argument === "--update") {
      update = true;
      continue;
    }
    if (!argument.startsWith("--")) {
      if (registryUrl) throw new Error("Only one registry URL may be provided");
      registryUrl = argument;
      continue;
    }
    const value = args[++index];
    if (!value) throw new Error(`${argument} requires a value`);
    switch (argument) {
      case "--font-css-url":
        cdnFonts.push(value);
        break;
      case "--local-font-css-url":
        localFonts.push(value);
        break;
      case "--id":
      case "--name":
        values.set(argument, value);
        break;
      default:
        throw new Error(`Unknown option: ${argument}`);
    }
  }

  const id = values.get("--id");
  const name = values.get("--name");
  if (!id || !name || !registryUrl) {
    throw new Error(
      "Usage: theme:import --id <id> --name <name> [--font-css-url <url>] [--local-font-css-url <path>] [--update] <registry-url>",
    );
  }
  const parsedUrl = new URL(registryUrl);
  if (parsedUrl.protocol !== "https:") throw new Error("Registry URL must use HTTPS");
  return { id, name, registryUrl, update, cdnFonts, localFonts };
}

async function fetchRegistryItem(url: string): Promise<Record<string, unknown>> {
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`Theme registry returned HTTP ${response.status}`);
  const body: unknown = await response.json();
  const item = Array.isArray(body) ? body[0] : body;
  if (!isRecord(item) || item.type !== "registry:style") {
    throw new Error("Registry URL did not return a compatible style item");
  }
  return item;
}

function readCssVariables(item: Record<string, unknown>): Record<string, Record<string, string>> {
  if (!isRecord(item.cssVars)) throw new Error("Registry style does not define CSS variables");
  const cssVars = item.cssVars;
  return Object.fromEntries(
    ["theme", "light", "dark"].map((group) => {
      const values = cssVars[group];
      if (values === undefined && group === "theme") return [group, {}];
      if (!isRecord(values)) throw new Error(`Registry style is missing ${group} CSS variables`);
      return [
        group,
        Object.fromEntries(
          Object.entries(values).map(([name, value]) => {
            if (typeof value !== "string") throw new Error(`CSS variable ${name} is not a string`);
            return [name, value];
          }),
        ),
      ];
    }),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

await main();
