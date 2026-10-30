import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { installExecutable, pathWith } from "../../../fs/tests/support/executable";

export async function prepareSandboxCli(
  directory: string,
  mode: string,
  name = "example",
): Promise<{ cwd: string; env: Record<string, string> }> {
  await installExecutable(new URL("../fixtures/sbx-run.ts", import.meta.url), directory, "sbx");
  const xdg = join(directory, "config");
  await mkdir(join(xdg, "eden"), { recursive: true });
  await Bun.write(join(xdg, "eden", "config.yaml"), "sandbox: { default_provider: docker-sbx }\n");

  return {
    cwd: directory,
    env: {
      PATH: pathWith(directory),
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
