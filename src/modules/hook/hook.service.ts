import { lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import * as v from "valibot";
import type { Execution } from "../execution";
import { findHookFile, HookResolutionError, resolveHookCommand } from "./hook-command";
import { ScriptRunner, type RunResult } from "../script/script-runner";

export type PreHookOutput = v.InferOutput<typeof PreHookOutputSchema>;

export type HookInput = {
  request: { name: string; baseBranch?: string };
  context: { cwd: string; repositoryName: string; worktreeRoot: string };
} & (
  | { proposed: v.InferOutput<typeof WorktreeValuesSchema> }
  | { result: v.InferOutput<typeof WorktreeValuesSchema> }
);

export type HookError = { code: string; message: string; exitCode?: number; signal?: string };

type HookDetails = { name: string; input: HookInput; stderr: string };

export type HookExecution = HookDetails &
  (
    | { ok: true; phase: "pre"; output: PreHookOutput }
    | { ok: true; phase: "post"; stdout: string }
    | { ok: false; stdout: string; error: HookError }
  );

export class HookService {
  readonly records: HookExecution[] = [];

  constructor(
    private readonly execution: Execution,
    private readonly options: {
      directory?: string;
      onStderr?: (text: string) => void;
    } = {},
  ) {}

  async discover(name: string): Promise<string | undefined> {
    const directory =
      this.options.directory ??
      join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "eden", "hooks");

    try {
      const path = await findHookFile(directory, name);

      if (!path) return;

      await lstat(path);

      return path;
    } catch (error) {
      if (error instanceof HookResolutionError) {
        throw new HookFailure({ code: error.code, message: error.message });
      }

      if (error instanceof Error && "code" in error && error.code === "ENOENT") return;

      throw error;
    }
  }

  async run(name: string, path: string, input: HookInput, cwd: string, phase: "pre" | "post") {
    let output: PreHookOutput = {};

    await this.execution.mutate(
      {
        type: "hook.run",
        description: `Run ${name}${phase === "pre" ? " (overwrites unknown until executed)" : ""}`,
        input: { name, path, cwd, input },
      },
      async () => {
        let stdout = "";
        let stderr = "";
        const controller = new AbortController();
        const cancel = () => controller.abort();
        process.on("SIGINT", cancel);
        process.on("SIGTERM", cancel);

        try {
          const command = await resolveHook(path);
          const result = await ScriptRunner.run(command.executable, JSON.stringify(input), {
            args: command.args,
            cwd,
            signal: controller.signal,
            onStderr: this.options.onStderr,
          });

          stdout = result.stdout;
          stderr = result.stderr;

          assertSucceeded(name, result);

          if (phase === "pre") {
            output = v.parse(PreHookOutputSchema, stdout.trim() ? JSON.parse(stdout) : {});

            this.records.push({ ok: true, phase, name, input, output, stderr });
          } else {
            this.records.push({ ok: true, phase, name, input, stdout, stderr });
          }
        } catch (cause) {
          const error = describeHookError(name, cause);

          this.records.push({ ok: false, name, input, stdout, stderr, error });

          throw new HookFailure(error);
        } finally {
          process.off("SIGINT", cancel);
          process.off("SIGTERM", cancel);
        }
      },
    );

    return output;
  }
}

const WorktreeValuesSchema = v.strictObject({
  branch: v.string(),
  path: v.string(),
  base: v.string(),
});

const PreHookOutputSchema = v.strictObject({
  overwrites: v.optional(v.partial(WorktreeValuesSchema)),
});

export class HookFailure extends Error {
  constructor(readonly detail: HookError) {
    super(detail.message);
  }
}

function assertSucceeded(name: string, result: RunResult): void {
  if (result.outcome === "exited" && result.exitCode === 0) return;

  const error: HookError = {
    code: result.outcome === "cancelled" ? "CANCELLED" : "HOOK_FAILED",
    message: `Hook ${name} ${result.outcome}`,
  };
  if (result.outcome === "exited") {
    error.exitCode = result.exitCode;
    error.message += ` with code ${result.exitCode}`;
  }
  if (result.outcome === "signaled") error.signal = result.signal;

  throw new HookFailure(error);
}

function describeHookError(name: string, cause: unknown): HookError {
  if (cause instanceof HookFailure) return cause.detail;

  return {
    code: "HOOK_FAILED",
    message: `Hook ${name}: ${cause instanceof Error ? cause.message : String(cause)}`,
  };
}

async function resolveHook(path: string) {
  try {
    return await resolveHookCommand(path);
  } catch (error) {
    if (error instanceof HookResolutionError) {
      throw new HookFailure({ code: error.code, message: error.message });
    }

    throw error;
  }
}
