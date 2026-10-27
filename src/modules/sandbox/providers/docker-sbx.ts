import { constants } from "node:os";
import * as v from "valibot";
import { ScriptRunner, type RunResult } from "../../script";
import { SandboxError } from "../errors";
import type { CreateSandboxInput, SandboxProvider, SandboxSummary } from "../provider";
import type { ReadinessCheck, ReadinessResult } from "../readiness";

export type DockerCommandResult = { exitCode: number; stdout: string; stderr: string };
export type DockerCommandRunner = (
  args: string[],
  options: { signal?: AbortSignal; onOutput?: (text: string) => void; sandboxName?: string },
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

  async create(input: CreateSandboxInput): Promise<void> {
    await this.execute(
      [
        "create",
        "--name",
        input.name,
        ...(input.image === undefined ? [] : ["--template", input.image]),
        "--skills",
        "off",
        ...(this.onCreateOutput ? [] : ["--no-progress"]),
        "shell",
      ],
      input.name,
    );
  }

  private async execute(args: string[], sandboxName?: string): Promise<void> {
    const { exitCode, stdout, stderr } = await (this.dependencies.run ?? runDockerCommand)(args, {
      sandboxName,
      onOutput: sandboxName === undefined ? undefined : this.onCreateOutput,
    });

    if (exitCode !== 0) throw diagnoseFailure(sandboxName, exitCode, `${stdout}\n${stderr}`);
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
  options: { signal?: AbortSignal; onOutput?: (text: string) => void; sandboxName?: string },
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

    return dockerCommandResult(result, options.sandboxName);
  } finally {
    if (!options.signal) process.off("SIGINT", interrupt);
  }
}

function dockerCommandResult(result: RunResult, sandboxName?: string): DockerCommandResult {
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
      : `Sandbox creation cancelled. Sandbox ${sandboxName} may already exist; no cleanup was attempted.`,
  );
}

function diagnoseFailure(
  name: string | undefined,
  exitCode: number,
  diagnostics: string,
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

  return new SandboxError(
    "SANDBOX_CREATE_FAILED",
    `Docker Sandboxes could not create sandbox ${name} (exit ${exitCode}). No retry or cleanup was attempted.${providerDetails}`,
  );
}

async function attachDockerSandbox(name: string): Promise<number> {
  const terminalState = process.stdin.isTTY
    ? Bun.spawnSync(["stty", "-g"], { stdin: "inherit", stdout: "pipe", stderr: "pipe" })
    : undefined;

  if (terminalState && terminalState.exitCode !== 0) {
    throw new SandboxError(
      "SANDBOX_INVALID_INPUT",
      "Could not save terminal settings before attaching.",
    );
  }

  let child: ReturnType<typeof Bun.spawn>;

  try {
    child = Bun.spawn(["sbx", "run", "--name", name], {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
  } catch {
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
    child.kill(signal);
    killTimer = setTimeout(() => child.kill("SIGKILL"), 1000);
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

    if (terminalState) {
      Bun.spawnSync(["stty", terminalState.stdout.toString().trim()], {
        stdin: "inherit",
        stdout: "ignore",
        stderr: "inherit",
      });
    }
  }
}
