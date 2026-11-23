import { readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const maxSuggestions = 100;

export async function listProjectDirectories(input: string, home = homedir()) {
  const root = resolve(home);
  const path = browsePath(input, root);
  if (path === null) {
    throw new Error(
      "Browse folders under Home, or enter the full repository path to import directly.",
    );
  }

  const canonicalRoot = await realpath(root);
  const folder = await readablePath(path, canonicalRoot);
  const exact = folder !== null && (await stat(folder)).isDirectory();
  if (!exact && input.endsWith(sep)) throw new Error("Folder not found under Home.");
  const directory = exact ? path : dirname(path);
  const prefix = directory === path ? "" : basename(path);
  const canonicalDirectory =
    directory === path ? folder : await readablePath(directory, canonicalRoot);
  if (canonicalDirectory === null) throw new Error("Folder not found under Home.");

  const entries = await readdir(canonicalDirectory, { withFileTypes: true });
  const filter = prefix.toLowerCase();
  const directories = entries
    .filter(
      (entry) =>
        entry.isDirectory() &&
        !entry.name.startsWith(".") &&
        entry.name.toLowerCase().startsWith(filter),
    )
    .map(({ name }) => ({ name, path: displayPath(root, join(directory, name)) }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    directory: displayPath(root, directory),
    parent: directory === root ? null : displayPath(root, dirname(directory)),
    prefix,
    directories: directories.slice(0, maxSuggestions),
    truncated: directories.length > maxSuggestions,
  };
}

function browsePath(input: string, root: string) {
  if (input.includes("\0") || input.length > 4096) return null;
  const path =
    input === "" || input === "~"
      ? root
      : input.startsWith("~/")
        ? resolve(root, input.slice(2))
        : isAbsolute(input)
          ? resolve(input)
          : null;

  if (path === null || !isInside(root, path)) return null;
  const segments = relative(root, path).split(sep);
  return segments.some((part) => part.startsWith(".")) ? null : path;
}

async function readablePath(path: string, root: string) {
  const canonical = await realpath(path).catch(() => null);
  if (canonical === null) return null;
  if (
    !isInside(root, canonical) ||
    relative(root, canonical)
      .split(sep)
      .some((part) => part.startsWith("."))
  ) {
    throw new Error(
      "Browse folders under Home, or enter the full repository path to import directly.",
    );
  }
  return canonical;
}

function isInside(root: string, path: string) {
  const child = relative(root, path);
  return child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function displayPath(root: string, path: string) {
  const child = relative(root, path);
  return child ? `~/${child}/` : "~/";
}
