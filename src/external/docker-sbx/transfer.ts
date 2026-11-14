import type { TransferSandboxInput, TransferSandboxResult } from "../../modules/sandbox/provider";
import { SandboxError } from "../../modules/sandbox/errors";

export async function transferDockerFiles(
  input: TransferSandboxInput,
): Promise<TransferSandboxResult> {
  let child: ReturnType<typeof Bun.spawn>;

  try {
    child = Bun.spawn(dockerTransferArguments(input), {
      stdin: input.stdinFile === undefined ? "ignore" : Bun.file(input.stdinFile),
      stdout: input.stdoutFile === undefined ? "ignore" : Bun.file(input.stdoutFile),
      stderr: "pipe",
      env: { ...process.env },
      windowsHide: true,
    });
  } catch {
    throw new SandboxError(
      "SANDBOX_PROVIDER_UNAVAILABLE",
      "Could not start Docker Sandboxes. Install sbx and ensure it is available on PATH.",
    );
  }

  const [exitCode, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr as ReadableStream<Uint8Array>).text(),
  ]);

  return { exitCode, stderr };
}

export function dockerTransferArguments(input: TransferSandboxInput): string[] {
  return [
    "sbx",
    "exec",
    ...(input.stdinFile === undefined ? [] : ["-i"]),
    "--",
    input.name,
    ...input.argv,
  ];
}
