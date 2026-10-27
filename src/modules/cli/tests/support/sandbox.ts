import { chmod, copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

export async function prepareSandboxCli(
  directory: string,
  mode: string,
  name = "example",
): Promise<{ cwd: string; env: Record<string, string> }> {
  await copyFile(new URL("../fixtures/sbx-run.ts", import.meta.url), join(directory, "sbx"));
  await chmod(join(directory, "sbx"), 0o755);
  const xdg = join(directory, "config");
  await mkdir(join(xdg, "eden"), { recursive: true });
  await Bun.write(join(xdg, "eden", "config.yaml"), "sandbox: { default_provider: docker-sbx }\n");

  return {
    cwd: directory,
    env: {
      PATH: `${directory}:${dirname(process.execPath)}:${process.env.PATH}`,
      XDG_CONFIG_HOME: xdg,
      EDEN_SBX_RUN_MODE: mode,
      EDEN_SBX_RUN_NAME: name,
      EDEN_SBX_RUN_LOG: join(directory, "commands"),
      EDEN_SBX_RUN_READY: join(directory, "ready"),
    },
  };
}

export async function sandboxCommands(directory: string) {
  return (await Bun.file(join(directory, "commands")).text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}
