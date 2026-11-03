import { ScriptRunner } from "../../modules/script";
import { SandboxError } from "../../modules/sandbox/errors";

export async function registryDigest(reference: string): Promise<string> {
  const manifest = parseJson(
    await templateCommand("docker", [
      "buildx",
      "imagetools",
      "inspect",
      reference,
      "--format",
      "{{json .Manifest}}",
    ]),
  );
  const digest = isRecord(manifest) ? manifest.digest : undefined;
  if (typeof digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(digest))
    throw new SandboxError(
      "SANDBOX_TEMPLATE_UPDATE_FAILED",
      "Registry returned an invalid image digest.",
    );
  return digest;
}

export async function templateCommand(executable: string, args: string[]): Promise<string> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  try {
    const result = await ScriptRunner.run(executable, null, {
      args,
      signal: controller.signal,
      killSignal: "SIGINT",
    }).catch(() => {
      throw new SandboxError(
        "SANDBOX_TEMPLATE_UPDATE_FAILED",
        `Could not start ${executable}; install it and make it available on PATH.`,
      );
    });
    if (result.outcome === "cancelled")
      throw new SandboxError(
        "CANCELLED",
        `Template update cancelled while running ${executable}. The template may have changed; check it before retrying.`,
      );
    if (result.outcome !== "exited" || result.exitCode !== 0)
      throw new SandboxError(
        "SANDBOX_TEMPLATE_UPDATE_FAILED",
        `${executable} failed while updating the template. ${result.stderr.trim()}`.trim(),
      );
    return result.stdout;
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new SandboxError(
      "SANDBOX_TEMPLATE_UPDATE_FAILED",
      "A template update command returned invalid JSON.",
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
