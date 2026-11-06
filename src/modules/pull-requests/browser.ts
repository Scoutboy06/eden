import { ScmError } from "./errors";

type Launcher = (command: string[]) => Promise<number>;

export async function openBrowser(
  url: string,
  platform: NodeJS.Platform = process.platform,
  launch: Launcher = runLauncher,
): Promise<void> {
  const command =
    platform === "win32"
      ? ["rundll32.exe", "url.dll,FileProtocolHandler", url]
      : [platform === "darwin" ? "open" : "xdg-open", url];

  try {
    if ((await launch(command)) === 0) return;
  } catch {}

  throw new ScmError(
    "SCM_BROWSER_FAILED",
    "Could not launch the browser. Use --print-url to print the PR URL instead.",
  );
}

async function runLauncher(command: string[]): Promise<number> {
  const child = Bun.spawn(command, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });

  return child.exited;
}
