import { SandboxError } from "../errors";
import type { CreateSandboxInput, SandboxProvider } from "../provider";

export class DockerSandboxProvider implements SandboxProvider {
  readonly name = "docker-sbx";

  constructor(private readonly onCreateOutput?: (text: string) => void) {}

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
      child.kill("SIGINT");
    };
    process.on("SIGINT", interrupt);

    try {
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        captureOutput(child.stdout, sandboxName === undefined ? undefined : this.onCreateOutput),
        new Response(child.stderr).text(),
      ]);

      if (cancelled || child.signalCode === "SIGINT") {
        throw new SandboxError(
          "CANCELLED",
          sandboxName === undefined
            ? "Sandbox prerequisite check cancelled."
            : `Sandbox creation cancelled. Sandbox ${sandboxName} may already exist; no cleanup was attempted.`,
        );
      }

      if (exitCode === 0) return;

      throw diagnoseFailure(sandboxName, exitCode, `${stdout}\n${stderr}`);
    } finally {
      process.off("SIGINT", interrupt);
    }
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
