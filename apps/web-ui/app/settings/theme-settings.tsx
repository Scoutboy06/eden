import { useEffect, useSyncExternalStore } from "react";

import { themeCatalog } from "../../themes/catalog";
import { generateThemeStylesheet } from "../../themes/stylesheet";

export type ThemeMode = "system" | "light" | "dark";

export interface ThemeSettings {
  mode: ThemeMode;
  lightTheme: string;
  darkTheme: string;
}

// Keep in sync with the bootstrap script in index.html.
const storageKey = "eden.theme-settings";
const themeStylesheetId = "application-theme";
const defaults: ThemeSettings = { mode: "system", lightTheme: "workbench", darkTheme: "workbench" };

const listeners = new Set<() => void>();
let current = readStoredSettings();

function readStoredSettings(): ThemeSettings {
  try {
    const stored = JSON.parse(localStorage.getItem(storageKey) ?? "{}") as Partial<ThemeSettings>;
    return {
      mode: ["system", "light", "dark"].includes(stored.mode ?? "") ? stored.mode! : defaults.mode,
      lightTheme: themeCatalog.find(stored.lightTheme ?? "")?.id ?? defaults.lightTheme,
      darkTheme: themeCatalog.find(stored.darkTheme ?? "")?.id ?? defaults.darkTheme,
    };
  } catch {
    return defaults;
  }
}

export function updateThemeSettings(patch: Partial<ThemeSettings>): void {
  current = { ...current, ...patch };
  try {
    localStorage.setItem(storageKey, JSON.stringify(current));
  } catch {
    // Storage unavailable: the selection still applies for this session.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useThemeSettings(): ThemeSettings {
  return useSyncExternalStore(subscribe, () => current);
}

export function ThemeEffect() {
  const { mode, lightTheme, darkTheme } = useThemeSettings();

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const dark = mode === "dark" || (mode === "system" && media.matches);
      document.documentElement.classList.toggle("dark", dark);
      document.documentElement.style.colorScheme = dark ? "dark" : "light";
    };
    apply();
    if (mode === "system") media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [mode]);

  useEffect(() => {
    let style = document.getElementById(themeStylesheetId);
    if (!style) {
      style = document.createElement("style");
      style.id = themeStylesheetId;
      document.head.append(style);
    }
    style.textContent = generateThemeStylesheet(themeCatalog, lightTheme, darkTheme);
  }, [lightTheme, darkTheme]);

  return null;
}
