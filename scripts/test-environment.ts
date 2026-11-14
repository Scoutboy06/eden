import { setDefaultTimeout } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isolateGitEnvironment } from "./git-environment";

isolateGitEnvironment(process.env);

const stateHome = mkdtempSync(join(tmpdir(), "eden-test-state-"));
process.env.XDG_STATE_HOME = stateHome;
process.on("exit", () => rmSync(stateHome, { recursive: true, force: true }));

const windowsSpawnTimeoutMs = 30_000;

if (process.platform === "win32") setDefaultTimeout(windowsSpawnTimeoutMs);
