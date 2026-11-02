import { ScmError } from "./errors";
import type { RepositoryRef } from "./provider";

export type Credential = { kind: "pat" | "bearer"; token: string };
export type CredentialCommand = (
  command: string,
  args: string[],
) => Promise<
  | {
      exitCode: number;
      stdout: string;
      stderr: string;
    }
  | undefined
>;

export async function resolveCredential(
  repository: RepositoryRef,
  options: {
    env?: Record<string, string | undefined>;
    run?: CredentialCommand;
  } = {},
): Promise<Credential | undefined> {
  const env = options.env ?? process.env;
  const run = options.run ?? runCredentialCommand;
  const token = environmentToken(repository.provider, env);

  if (token) return { kind: "pat", token };

  const result =
    repository.provider === "github"
      ? await run("gh", ["auth", "token", "--hostname", "github.com"])
      : await run("az", [
          "account",
          "get-access-token",
          "--resource",
          "499b84ac-1321-427f-aa17-267ca6975798",
          "--output",
          "json",
        ]);

  if (!result) return;
  if (result.exitCode !== 0) {
    if (
      /not logged|no oauth token|no token found|az login|login required|AADSTS50058/i.test(
        result.stderr,
      )
    )
      return;

    throw new ScmError(
      "SCM_CREDENTIAL_LOOKUP_FAILED",
      "Could not obtain provider credentials from the CLI. Check its login or set an environment token.",
    );
  }

  return decodeCredential(repository.provider, result.stdout);
}

function environmentToken(
  provider: RepositoryRef["provider"],
  env: Record<string, string | undefined>,
) {
  return provider === "github"
    ? env.GH_TOKEN?.trim() || env.GITHUB_TOKEN?.trim()
    : env.AZURE_DEVOPS_EXT_PAT?.trim();
}

function decodeCredential(provider: RepositoryRef["provider"], stdout: string): Credential {
  if (provider === "github") {
    const token = stdout.trim();
    if (token) return { kind: "pat", token };
  } else {
    try {
      const parsed: unknown = JSON.parse(stdout);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "accessToken" in parsed &&
        typeof parsed.accessToken === "string" &&
        parsed.accessToken.trim()
      )
        return { kind: "bearer", token: parsed.accessToken.trim() };
    } catch {}
  }

  throw new ScmError(
    "SCM_CREDENTIAL_LOOKUP_FAILED",
    "The authentication CLI returned an invalid credential response.",
  );
}

async function runCredentialCommand(command: string, args: string[]) {
  const executable = Bun.which(command);
  if (!executable) return;

  try {
    const child = Bun.spawn([executable, ...args], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 15_000,
      env: {
        ...process.env,
        GH_PROMPT_DISABLED: "1",
        AZURE_CORE_COLLECT_TELEMETRY: "false",
        AZURE_EXTENSION_USE_DYNAMIC_INSTALL: "no",
      },
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    return { exitCode, stdout, stderr };
  } catch {
    throw new ScmError("SCM_CREDENTIAL_LOOKUP_FAILED", "Could not run the authentication CLI.");
  }
}
