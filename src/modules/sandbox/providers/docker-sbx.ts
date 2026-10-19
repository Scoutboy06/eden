import { SandboxError } from "../errors";
import type { CreateSandboxInput, SandboxProvider } from "../provider";
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
    private readonly dependencies: { run?: DockerCommandRunner; isInstalled?: () => boolean } = {},
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
  let child;

  try {
    child = Bun.spawn(["sbx", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  } catch {
    throw new SandboxError(
      "SANDBOX_PROVIDER_UNAVAILABLE",
      "Could not start Docker Sandboxes. Install sbx and ensure it is available on PATH.",
    );
  }

  let cancelled = false;
  const interrupt = () => {
    cancelled = true;
    child.kill(options.signal ? "SIGKILL" : "SIGINT");
  };
  if (options.signal) options.signal.addEventListener("abort", interrupt, { once: true });
  else process.on("SIGINT", interrupt);

  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      captureOutput(child.stdout, options.onOutput),
      new Response(child.stderr).text(),
    ]);

    if (cancelled || child.signalCode === "SIGINT") {
      throw new SandboxError(
        "CANCELLED",
        options.sandboxName === undefined
          ? "Sandbox prerequisite check cancelled."
          : `Sandbox creation cancelled. Sandbox ${options.sandboxName} may already exist; no cleanup was attempted.`,
      );
    }

    return { exitCode, stdout, stderr };
  } finally {
    if (options.signal) options.signal.removeEventListener("abort", interrupt);
    else process.off("SIGINT", interrupt);
  }
}

async function captureOutput(
  stream: ReadableStream<Uint8Array>,
  onOutput?: (text: string) => void,
): Promise<string> {
  const decoder = new TextDecoder();
  let output = "";

  for await (const chunk of stream) {
    const text = decoder.decode(chunk, { stream: true });
    output += text;
    onOutput?.(text);
  }

  const remaining = decoder.decode();
  output += remaining;
  if (remaining) onOutput?.(remaining);

  return output;
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
