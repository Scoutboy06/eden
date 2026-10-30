import { chmod, copyFile, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export async function installExecutable(source: URL | string, directory: string, name: string) {
  const script = source instanceof URL ? fileURLToPath(source) : source;

  if (process.platform === "win32") {
    const path = join(directory, `${name}.cmd`);
    await writeFile(path, `@"${process.execPath}" "${script}" %*\r\n`);

    return path;
  }

  const path = join(directory, name);
  await copyFile(script, path);
  await chmod(path, 0o755);

  return path;
}

export function pathWith(directory: string) {
  return [directory, dirname(process.execPath), process.env.PATH].join(delimiter);
}

export async function canCreateSymlinks() {
  const directory = await mkdtemp(join(tmpdir(), "eden-symlink-probe-"));
  try {
    await symlink(join(directory, "target"), join(directory, "link"));

    return true;
  } catch {
    return false;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
