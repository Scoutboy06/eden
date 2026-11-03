import { constants } from "node:os";
import * as v from "valibot";
import { ScriptRunner, type RunResult } from "../../modules/script";
import { SandboxError } from "../../modules/sandbox/errors";
import type {
  CreateSandboxInput,
  ExecSandboxInput,
  ExecSandboxResult,
  SandboxProvider,
  SandboxSummary,
} from "../../modules/sandbox/provider";
import type { ReadinessCheck, ReadinessResult } from "../../modules/sandbox/readiness";
import { saveTerminal, type TerminalSaver } from "./terminal";

export type DockerCommandResult = { exitCode: number; stdout: string; stderr: string };
export type DockerCommandRunner = (
  args: string[],
  options: {
    signal?: AbortSignal;
    env?: Record<string, string>;
    onOutput?: (text: string) => void;
    sandboxName?: string;
    operation?: "create" | "stop" | "remove" | "exec";
    inheritIO?: boolean;
  },
) => Promise<DockerCommandResult>;

export class DockerSandboxProvider implements SandboxProvider {
  readonly name = "docker-sbx";

  constructor(
    private readonly onCreateOutput?: (text: string) => void,
    private readonly dependencies: {
      run?: DockerCommandRunner;
      attach?: (name: string) => Promise<number>;
      attachExec?: (input: ExecSandboxInput) => Promise<number>;
      isInstalled?: () => boolean;
      interactiveCreate?: boolean;
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
        run: (signal) => this.check(["ls", "--json"], "Signed in", "Login", signal),
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

  async preflight(input: CreateSandboxInput): Promise<void> {
    dockerAgent(input.agent);
    validateWorkspace(input.workspace, input.mounts);
    await this.execute(["ls", "--json"]);
    await this.execute(["policy", "ls", "--json"]);
  }

  async list(): Promise<SandboxSummary[]> {
    const result = await (this.dependencies.run ?? runDockerCommand)(["ls", "--json"], {});

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

    const entries = Array.isArray(parsed.output) ? parsed.output : parsed.output.sandboxes;

    return entries.map((entry) => ({
      provider: this.name,
      name: entry.name,
      status: entry.status,
    }));
  }

  run(name: string): Promise<number> {
    return (this.dependencies.attach ?? attachDockerSandbox)(name);
  }

  async exec(input: ExecSandboxInput): Promise<ExecSandboxResult> {
    if (input.output === "inherit") {
      const exitCode = await (this.dependencies.attachExec ?? attachDockerExec)(input);
      if (exitCode === 125) {
        throw new SandboxError(
          "SANDBOX_PROVIDER_UNAVAILABLE",
          `Docker Sandboxes could not execute the command in ${input.name}.`,
        );
      }
      return { exitCode, stdout: "", stderr: "" };
    }
    const result = await (this.dependencies.run ?? runDockerCommand)(
      ["exec", "--", input.name, ...input.argv],
      { sandboxName: input.name, operation: "exec", inheritIO: false },
    );
    if (result.exitCode === 125) {
      throw new SandboxError(
        "SANDBOX_PROVIDER_UNAVAILABLE",
        `Docker Sandboxes could not execute the command in ${input.name}.${result.stderr ? `\n\n${result.stderr.trim()}` : ""}`,
      );
    }
    return result;
  }

  async stop(name: string): Promise<void> {
    await this.execute(["stop", "--", name], name, "stop");
  }

  async remove(name: string, force: boolean): Promise<void> {
    await this.execute(
      ["rm", ...(force ? ["--force"] : []), "--", name],
      name,
      "remove",
      undefined,
      !force,
    );
  }

  async create(input: CreateSandboxInput): Promise<void> {
    validateWorkspace(input.workspace, input.mounts);
    await this.execute(
      [
        "create",
        "--name",
        input.name,
        ...(input.image === undefined ? [] : ["--template", input.image]),
        ...(input.pull === undefined ? [] : ["--pull", input.pull]),
        ...(input.kits ?? []).flatMap((kit) => ["--kit", kit]),
        ...(input.mcpServers ?? []).flatMap((server) => ["--static-mcp", server]),
        ...Object.entries(input.kitArgs ?? {}).flatMap(([key, value]) => [
          "--kit-arg",
          `${key}=${String(value)}`,
        ]),
        "--skills",
        "off",
        ...(this.onCreateOutput || this.dependencies.interactiveCreate ? [] : ["--no-progress"]),
        ...(input.workspace?.mode === "clone" ? ["--clone"] : []),
        dockerAgent(input.agent),
        ...(input.workspace?.path === undefined ? [] : [input.workspace.path]),
        ...Object.values(input.mounts ?? {}).map(
          (mount) => `${mount.path}${mount.readonly ? ":ro" : ""}`,
        ),
      ],
      input.name,
      "create",
      {
        ...(input.disk?.root === undefined ? {} : { DOCKER_SANDBOXES_ROOT_SIZE: input.disk.root }),
        ...(input.disk?.docker === undefined
          ? {}
          : { DOCKER_SANDBOXES_DOCKER_SIZE: input.disk.docker }),
      },
      this.dependencies.interactiveCreate ?? false,
    );
  }

  private async execute(
    args: string[],
    sandboxName?: string,
    operation: "create" | "stop" | "remove" = "create",
    env?: Record<string, string>,
    inheritIO = false,
  ): Promise<void> {
    const { exitCode, stdout, stderr } = await (this.dependencies.run ?? runDockerCommand)(args, {
      sandboxName,
      operation,
      env,
      inheritIO,
      onOutput:
        sandboxName === undefined || operation !== "create" ? undefined : this.onCreateOutput,
    });

    const diagnostics = `${stdout}\n${stderr}`;
    if (
      operation === "create" &&
      sandboxName !== undefined &&
      !inheritIO &&
      credentialApprovalMissing(stderr)
    ) {
      const state =
        exitCode === 0
          ? `Sandbox ${sandboxName} was created and is left in place.`
          : `Sandbox ${sandboxName} may already exist; check before retrying.`;
      throw new SandboxError(
        "SANDBOX_CREDENTIAL_APPROVAL_REQUIRED",
        `Docker Sandboxes reported a credential without an approved binding. ${state} In a terminal, run sbx create --name <new-name> <agent> --kit <kit> using the same agent and kits to approve the credential.`,
      );
    }
    if (exitCode !== 0) throw diagnoseFailure(sandboxName, exitCode, diagnostics, operation);
  }
}

function credentialApprovalMissing(diagnostics: string): boolean {
  return /required credential has no binding; sandbox will start without it/i.test(diagnostics);
}

function validateWorkspace(
  workspace: CreateSandboxInput["workspace"],
  mounts?: CreateSandboxInput["mounts"],
): void {
  if ((!workspace || workspace.mode === "none") && Object.keys(mounts ?? {}).length) {
    throw new SandboxError(
      "SANDBOX_INVALID_INPUT",
      "Named mounts require a clone or host workspace.",
    );
  }
  if (workspace && (workspace.mode === "none") !== (workspace.path === undefined)) {
    throw new SandboxError(
      "SANDBOX_INVALID_INPUT",
      "Workspace path must be supplied only for clone or host mode.",
    );
  }
}

function dockerAgent(agent: CreateSandboxInput["agent"]): string {
  switch (agent) {
    case undefined:
      return "shell";
    case "claude":
      return "claude";
    case "codex":
      return "codex";
    case "opencode":
      return "opencode";
    case "omp":
      throw new SandboxError(
        "SANDBOX_AGENT_UNSUPPORTED",
        "Docker Sandboxes does not support the omp agent. Choose claude, codex, or opencode in the sandbox profile.",
      );
  }
}

const DockerSandboxEntriesSchema = v.array(
  v.object({
    name: v.string(),
    status: v.string(),
  }),
);
const DockerSandboxListSchema = v.union([
  DockerSandboxEntriesSchema,
  v.object({ sandboxes: DockerSandboxEntriesSchema }),
]);

function readinessFailure(error: unknown, subject: string): ReadinessResult {
  const code = error instanceof SandboxError ? error.code : undefined;

  switch (code) {
    case "SANDBOX_PROVIDER_UNAVAILABLE":
      return {
        state: "unknown",
        label: "Docker Sandboxes unavailable",
        instructions: [error instanceof Error ? error.message : String(error)],
      };
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
  if (!options.signal) process.on("SIGTERM", interrupt);

  try {
    const result = await ScriptRunner.run("sbx", null, {
      args,
      env: options.env,
      inheritIO: options.inheritIO,
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
    if (!options.signal) process.off("SIGTERM", interrupt);
  }
}

function dockerCommandResult(
  result: RunResult,
  sandboxName?: string,
  operation: "create" | "stop" | "remove" | "exec" = "create",
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
      : operation === "exec"
        ? `Execution in sandbox ${sandboxName} cancelled.`
        : operation === "remove"
          ? `Removing sandbox ${sandboxName} cancelled. It may already have been removed; no retry was attempted.`
          : operation === "stop"
            ? `Stopping sandbox ${sandboxName} cancelled. It may already be stopped; no removal or cleanup was attempted.`
            : `Sandbox creation cancelled. Sandbox ${sandboxName} may already exist; no cleanup was attempted.`,
  );
}

function diagnoseFailure(
  name: string | undefined,
  exitCode: number,
  diagnostics: string,
  operation: "create" | "stop" | "remove" = "create",
): SandboxError {
  if (/unknown (?:flag|option):?\s*["']?--json\b/i.test(diagnostics)) {
    return new SandboxError(
      "SANDBOX_PROVIDER_UNAVAILABLE",
      "Docker Sandboxes does not support JSON output required by Eden. Update sbx and try again.",
    );
  }

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

  if (operation === "remove") {
    return new SandboxError(
      "SANDBOX_REMOVE_FAILED",
      `Docker Sandboxes could not remove sandbox ${name} (exit ${exitCode}). No retry or cleanup was attempted.${providerDetails}`,
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

function attachDockerExec(input: ExecSandboxInput): Promise<number> {
  return attachDockerSandbox(input.name, {
    spawn: () =>
      Bun.spawn(["sbx", "exec", "-i", "--", input.name, ...input.argv], {
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      }),
  });
}
