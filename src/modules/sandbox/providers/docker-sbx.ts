import { constants } from "node:os";
import * as v from "valibot";
import { ScriptRunner, type RunResult } from "../../script";
import { SandboxError } from "../errors";
import type { CreateSandboxInput, SandboxProvider, SandboxSummary } from "../provider";
import type { ReadinessCheck, ReadinessResult } from "../readiness";
import { saveTerminal, type TerminalSaver } from "./terminal";

export type DockerCommandResult = { exitCode: number; stdout: string; stderr: string };
export type DockerCommandRunner = (
  args: string[],
  options: {
    signal?: AbortSignal;
    onOutput?: (text: string) => void;
    sandboxName?: string;
    operation?: "create" | "stop";
  },
) => Promise<DockerCommandResult>;

export class DockerSandboxProvider implements SandboxProvider {
  readonly name = "docker-sbx";

  constructor(
    private readonly onCreateOutput?: (text: string) => void,
    private readonly dependencies: {
      run?: DockerCommandRunner;
      attach?: (name: string) => Promise<number>;
      isInstalled?: () => boolean;
    } = {},
  ) {}

  readinessChecks(): readonly ReadinessCheck[] {
    return [
      {
        id: "installation",
        checkingLabel: "Checking installation",
        skippedLabel: "Installation not checked",
        dependencies: [],
        run: async () =>
          (this.dependencies.isInstalled ?? (() => Bun.which("sbx") !== null))()
            ? { state: "ready", label: "Installed" }
            : {
                state: "missing",
                label: "Not installed",
                instructions: ["Install sbx and add it to PATH."],
              },
      },
      {
        id: "login",
        checkingLabel: "Checking login",
        skippedLabel: "Login not checked",
        dependencies: ["installation"],
        instructions: ["Check it separately:", "  sbx ls"],
        run: (signal) => this.check(["ls", "--format", "json"], "Signed in", "Login", signal),
      },
      {
        id: "policy",
        checkingLabel: "Checking policy",
        skippedLabel: "Policy not checked",
        dependencies: ["installation"],
        instructions: ["Check it separately:", "  sbx policy ls"],
        run: (signal) =>
          this.check(["policy", "ls", "--json"], "Policy configured", "Policy", signal),
      },
    ];
  }

  private async check(
    args: string[],
    readyLabel: string,
    subject: string,
    signal: AbortSignal,
  ): Promise<ReadinessResult> {
    try {
      const result = await (this.dependencies.run ?? runDockerCommand)(args, { signal });

      if (result.exitCode === 0) return { state: "ready", label: readyLabel };

      throw diagnoseFailure(undefined, result.exitCode, `${result.stdout}\n${result.stderr}`);
    } catch (error) {
      if (signal.aborted) throw error;

      return readinessFailure(error, subject);
    }
  }

  async preflight(): Promise<void> {
    await this.execute(["ls", "--format", "json"]);
    await this.execute(["policy", "ls", "--json"]);
  }

  async list(): Promise<SandboxSummary[]> {
    const result = await (this.dependencies.run ?? runDockerCommand)(
      ["ls", "--format", "json"],
      {},
    );

    if (result.exitCode !== 0) {
      throw diagnoseFailure(undefined, result.exitCode, `${result.stdout}\n${result.stderr}`);
    }

    let sandboxes: unknown;

    try {
      sandboxes = JSON.parse(result.stdout);
    } catch {
      throw new SandboxError(
        "SANDBOX_LOOKUP_FAILED",
        "Docker Sandboxes returned invalid sandbox listing JSON.",
      );
    }

    const parsed = v.safeParse(DockerSandboxListSchema, sandboxes);

    if (!parsed.success) {
      throw new SandboxError(
        "SANDBOX_LOOKUP_FAILED",
        "Docker Sandboxes returned an invalid sandbox listing.",
      );
    }

    return parsed.output.map((entry) => ({
      provider: this.name,
      name: entry.name,
      status: entry.status,
    }));
  }

  run(name: string): Promise<number> {
    return (this.dependencies.attach ?? attachDockerSandbox)(name);
  }

  async stop(name: string): Promise<void> {
    await this.execute(["stop", "--", name], name, "stop");
  }

  async create(input: CreateSandboxInput): Promise<void> {
    await this.execute(
      [
        "create",
        "--name",
        input.name,
        ...(input.image === undefined ? [] : ["--template", input.image]),
        ...(input.kits ?? []).flatMap((kit) => ["--kit", kit]),
        ...Object.entries(input.kitArgs ?? {}).flatMap(([key, value]) => [
          "--kit-arg",
          `${key}=${String(value)}`,
        ]),
        "--skills",
        "off",
        ...(this.onCreateOutput ? [] : ["--no-progress"]),
        "shell",
      ],
      input.name,
    );
  }

  private async execute(
    args: string[],
    sandboxName?: string,
    operation: "create" | "stop" = "create",
  ): Promise<void> {
    const { exitCode, stdout, stderr } = await (this.dependencies.run ?? runDockerCommand)(args, {
      sandboxName,
      operation,
      onOutput:
        sandboxName === undefined || operation !== "create" ? undefined : this.onCreateOutput,
    });

    if (exitCode !== 0)
      throw diagnoseFailure(sandboxName, exitCode, `${stdout}\n${stderr}`, operation);
  }
}

const DockerSandboxListSchema = v.array(
  v.object({
    name: v.string(),
    status: v.string(),
  }),
);

function readinessFailure(error: unknown, subject: string): ReadinessResult {
  const code = error instanceof SandboxError ? error.code : undefined;

  switch (code) {
    case "SANDBOX_AUTH_REQUIRED":
      return subject === "Policy"
        ? { state: "skipped", label: "Policy not checked" }
        : {
            state: "missing",
            label: "Sign-in required",
            instructions: ["Sign in with:", "  sbx login"],
          };
    case "SANDBOX_NETWORK_POLICY_REQUIRED":
      return {
        state: "missing",
        label: "Policy required",
        instructions: [
          "Choose a global network policy:",
          "  sbx policy init <allow-all|balanced|deny-all>",
          "This affects all local Docker Sandboxes, not just Eden.",
        ],
      };
    default:
      return {
        state: "unknown",
        label: `${subject} unknown`,
        instructions: [
          "Could not check Docker Sandboxes.",
          error instanceof Error ? error.message : String(error),
          "Check it separately:",
          `  ${subject === "Login" ? "sbx ls" : "sbx policy ls"}`,
        ],
      };
  }
}

async function runDockerCommand(
  args: string[],
  options: Parameters<DockerCommandRunner>[1],
): Promise<DockerCommandResult> {
  options.signal?.throwIfAborted();
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  if (!options.signal) process.on("SIGINT", interrupt);

  try {
    const result = await ScriptRunner.run("sbx", null, {
      args,
      signal: options.signal ?? controller.signal,
      killSignal: options.signal ? "SIGKILL" : "SIGINT",
      onStdout: options.onOutput,
    }).catch(() => {
      throw new SandboxError(
        "SANDBOX_PROVIDER_UNAVAILABLE",
        "Could not start Docker Sandboxes. Install sbx and ensure it is available on PATH.",
      );
    });

    return dockerCommandResult(result, options.sandboxName, options.operation);
  } finally {
    if (!options.signal) process.off("SIGINT", interrupt);
  }
}

function dockerCommandResult(
  result: RunResult,
  sandboxName?: string,
  operation: "create" | "stop" = "create",
): DockerCommandResult {
  switch (result.outcome) {
    case "exited":
      return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
    case "signaled":
      if (result.signal !== "SIGINT") {
        return {
          exitCode: 128 + constants.signals[result.signal as NodeJS.Signals],
          stdout: result.stdout,
          stderr: result.stderr,
        };
      }
      break;
  }

  throw new SandboxError(
    "CANCELLED",
    sandboxName === undefined
      ? "Sandbox prerequisite check cancelled."
      : operation === "stop"
        ? `Stopping sandbox ${sandboxName} cancelled. It may already be stopped; no removal or cleanup was attempted.`
        : `Sandbox creation cancelled. Sandbox ${sandboxName} may already exist; no cleanup was attempted.`,
  );
}

function diagnoseFailure(
  name: string | undefined,
  exitCode: number,
  diagnostics: string,
  operation: "create" | "stop" = "create",
): SandboxError {
  if (/\bnot signed in to Docker\b/i.test(diagnostics)) {
    return new SandboxError(
      "SANDBOX_AUTH_REQUIRED",
      "Not signed in to Docker.\n\nSign in to continue:\n  sbx login",
    );
  }

  if (/\bglobal network policy has not been initialized\b/i.test(diagnostics)) {
    return new SandboxError(
      "SANDBOX_NETWORK_POLICY_REQUIRED",
      "Docker Sandboxes network policy has not been initialized.\n\nChoose a global policy before creating a sandbox:\n  sbx policy init <allow-all|balanced|deny-all>\n\nThis applies to all local Docker Sandboxes, not just Eden-created ones.",
    );
  }

  if (name !== undefined && /\bsandbox ['"][^'"\r\n]+['"] already exists\b/i.test(diagnostics)) {
    return new SandboxError(
      "SANDBOX_ALREADY_EXISTS",
      `Sandbox ${name} already exists.\n\nConnect to it with:\n  sbx run --name ${name}`,
    );
  }

  const details = diagnostics.trim();
  const providerDetails = details ? `\n\nDocker Sandboxes reported:\n${details}` : "";

  if (name === undefined) {
    return new SandboxError(
      "SANDBOX_PREFLIGHT_FAILED",
      `Could not check Docker Sandboxes prerequisites (exit ${exitCode}).${providerDetails}`,
    );
  }

  if (operation === "stop") {
    return new SandboxError(
      "SANDBOX_STOP_FAILED",
      `Docker Sandboxes could not stop sandbox ${name} (exit ${exitCode}). No retry or cleanup was attempted.${providerDetails}`,
    );
  }

  return new SandboxError(
    "SANDBOX_CREATE_FAILED",
    `Docker Sandboxes could not create sandbox ${name} (exit ${exitCode}). No retry or cleanup was attempted.${providerDetails}`,
  );
}

export type AttachDependencies = {
  saveTerminal?: TerminalSaver;
  spawn?: (name: string) => ReturnType<typeof Bun.spawn>;
  platform?: NodeJS.Platform;
  isTerminal?: boolean;
  killGraceMs?: number;
};

export async function attachDockerSandbox(
  name: string,
  dependencies: AttachDependencies = {},
): Promise<number> {
  const platform = dependencies.platform ?? process.platform;
  const restoreTerminal =
    (dependencies.isTerminal ?? process.stdin.isTTY)
      ? (dependencies.saveTerminal ?? (() => saveTerminal(platform)))()
      : undefined;

  let child: ReturnType<typeof Bun.spawn>;

  try {
    child = (dependencies.spawn ?? spawnDockerAttach)(name);
  } catch {
    restoreTerminal?.();

    throw new SandboxError(
      "SANDBOX_PROVIDER_UNAVAILABLE",
      "Could not start Docker Sandboxes. Install sbx and ensure it is available on PATH.",
    );
  }

  let cancellationExitCode: number | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const cancel = (signal: "SIGINT" | "SIGTERM") => {
    if (cancellationExitCode !== undefined) return;

    cancellationExitCode = 128 + constants.signals[signal];
    if (!(platform === "win32" && signal === "SIGINT")) child.kill(signal);
    killTimer = setTimeout(() => child.kill("SIGKILL"), dependencies.killGraceMs ?? 1000);
    killTimer.unref();
  };
  const interrupt = () => cancel("SIGINT");
  const terminate = () => cancel("SIGTERM");
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);

  try {
    const exitCode = await child.exited;

    return cancellationExitCode ?? exitCode;
  } finally {
    clearTimeout(killTimer);
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
    restoreTerminal?.();
  }
}

function spawnDockerAttach(name: string): ReturnType<typeof Bun.spawn> {
  return Bun.spawn(["sbx", "run", "--name", name], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
}
