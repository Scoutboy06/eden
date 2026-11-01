import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Execution } from "../execution";
import { ScriptRunner } from "../script";
import type { SandboxProfile } from "../config/schema";
import { SandboxError } from "./errors";
import { assessTemplateSandboxes, canonicalReference } from "./template-sandbox-status";

export type TemplateEntry = { repository: string; tag: string; id: string };
export type Receipt = {
  reference: string;
  digest: string;
  platform: string;
  imageId: string;
  archiveHash: string;
};

export class TemplateUpdateService {
  constructor(private readonly execution: Execution) {}

  async update(name: string, profile: SandboxProfile, provider?: string) {
    if (provider !== "docker-sbx")
      throw failure(
        "Choose Docker Sandboxes as the profile provider before updating its template.",
      );
    const reference = profile.template;
    if (!reference)
      throw failure(`Sandbox profile ${JSON.stringify(name)} does not specify a template.`);
    const { repository, tag } = parseReference(reference);
    const platform = sandboxPlatform();
    const digest = await registryDigest(reference);
    const entries = parseTemplates(await templateCommand("sbx", ["template", "ls", "--json"]));
    const current = findTemplate(entries, repository, tag);
    const paths = cachePaths(reference, digest, platform);
    const receipt = await readReceipt(paths.receipt);
    const cached =
      receipt?.reference === reference &&
      receipt.digest === digest &&
      receipt.platform === platform;
    if (cached && current && sameImageId(current.id, receipt.imageId)) {
      return {
        profile: name,
        template: reference,
        digest,
        status: "current",
        sandboxes: await assessTemplateSandboxes(reference, receipt.imageId, (args) =>
          templateCommand("sbx", args),
        ),
      };
    }

    const useArchive =
      cached && (await fileHash(paths.archive).catch(() => undefined)) === receipt.archiveHash;
    let verifiedImageId: string | undefined;
    await this.execution.mutate(
      {
        type: "sandbox.template.update",
        description: `Update template ${reference} to ${digest}${useArchive ? " from verified cache" : " via Docker pull"}; sandbox status will be inspected after loading`,
        input: {
          profile: name,
          template: reference,
          digest,
          platform,
          cached: useArchive,
          outdatedSandboxes: null,
        },
      },
      async () => {
        await mkdir(paths.directory, { recursive: true, mode: 0o700 });
        let archiveHash = receipt?.archiveHash;
        if (!useArchive) {
          const immutable = `${repository}@${digest}`;
          await templateCommand("docker", ["image", "pull", "--platform", platform, immutable]);
          const digests = parseJson(
            await templateCommand("docker", [
              "image",
              "inspect",
              immutable,
              "--format",
              "{{json .RepoDigests}}",
            ]),
          );
          if (
            !Array.isArray(digests) ||
            !digests.some(
              (value: unknown) => typeof value === "string" && value.endsWith(`@${digest}`),
            )
          )
            throw failure("Docker did not verify the pulled registry digest.");
          const rawImageId = parseJson(
            await templateCommand("docker", [
              "image",
              "inspect",
              immutable,
              "--format",
              "{{json .Id}}",
            ]),
          );
          if (typeof rawImageId !== "string" || !/^sha256:[a-f0-9]{64}$/.test(rawImageId))
            throw failure("Docker returned an invalid image ID.");
          await templateCommand("docker", ["image", "tag", immutable, reference]);
          const temporary = `${paths.archive}.${crypto.randomUUID()}.tmp`;
          try {
            await templateCommand("docker", ["image", "save", "--output", temporary, reference]);
            archiveHash = await fileHash(temporary);
            await rename(temporary, paths.archive);
          } finally {
            await rm(temporary, { force: true });
          }
        }
        try {
          await templateCommand("sbx", ["template", "load", paths.archive]);
        } catch (error) {
          if (error instanceof SandboxError) {
            throw new SandboxError(
              error.code,
              `${error.message} The template may already have changed; check it before retrying.`,
            );
          }
          throw error;
        }
        const loaded = findTemplate(
          parseTemplates(await templateCommand("sbx", ["template", "ls", "--json"])),
          repository,
          tag,
        );
        if (!loaded || !/^(?:sha256:)?[a-f0-9]{12,64}$/.test(loaded.id))
          throw failure(
            "Docker Sandboxes did not report a valid loaded template ID; the template may have changed and no success receipt was saved.",
          );
        verifiedImageId = loaded.id;
        const next: Receipt = {
          reference,
          digest,
          platform,
          imageId: loaded.id,
          archiveHash: archiveHash!,
        };
        const temporary = `${paths.receipt}.${crypto.randomUUID()}.tmp`;
        try {
          await writeFile(temporary, JSON.stringify(next), { mode: 0o600 });
          await rename(temporary, paths.receipt);
        } finally {
          await rm(temporary, { force: true });
        }
      },
    );
    return {
      profile: name,
      template: reference,
      digest,
      status: "updated",
      sandboxes:
        verifiedImageId === undefined
          ? null
          : await assessTemplateSandboxes(reference, verifiedImageId, (args) =>
              templateCommand("sbx", args),
            ),
    };
  }
}

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
    throw failure("Registry returned an invalid image digest.");
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
      throw failure(`Could not start ${executable}; install it and make it available on PATH.`);
    });
    if (result.outcome === "cancelled")
      throw new SandboxError(
        "CANCELLED",
        `Template update cancelled while running ${executable}. The template may have changed; check it before retrying.`,
      );
    if (result.outcome !== "exited" || result.exitCode !== 0)
      throw failure(
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
    throw failure("A template update command returned invalid JSON.");
  }
}

export function parseTemplates(text: string): TemplateEntry[] {
  const data: unknown = parseJson(text);
  const values = isRecord(data) && Array.isArray(data.images) ? data.images : data;
  if (
    !Array.isArray(values) ||
    !values.every(
      (entry) =>
        entry &&
        typeof entry.repository === "string" &&
        typeof entry.tag === "string" &&
        typeof entry.id === "string",
    )
  )
    throw failure("Docker Sandboxes returned invalid template metadata.");
  return values as TemplateEntry[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseReference(reference: string) {
  if (!reference || reference.startsWith("-") || /\s|@/.test(reference))
    throw failure("The profile template must be a tagged registry image reference.");
  const slash = reference.lastIndexOf("/");
  const colon = reference.lastIndexOf(":");
  return {
    repository: colon > slash ? reference.slice(0, colon) : reference,
    tag: colon > slash ? reference.slice(colon + 1) : "latest",
  };
}

export function findTemplate(
  entries: TemplateEntry[],
  repository: string,
  tag: string,
): TemplateEntry | undefined {
  return entries.find(
    (entry) =>
      canonicalReference(`${entry.repository}:${entry.tag}`) ===
      canonicalReference(`${repository}:${tag}`),
  );
}

export function sandboxPlatform(): string {
  if (process.arch === "x64") return "linux/amd64";
  if (process.arch === "arm64") return "linux/arm64";
  throw failure(`Unsupported sandbox platform: ${process.arch}.`);
}

export function cachePaths(reference: string, digest: string, platform: string) {
  const root = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  const directory = join(root, "eden", "templates");
  const key = createHash("sha256").update(`${reference}\0${digest}\0${platform}`).digest("hex");
  return {
    directory,
    archive: join(directory, `${key}.tar`),
    receipt: join(directory, `${key}.json`),
  };
}

export async function readReceipt(path: string): Promise<Receipt | undefined> {
  try {
    const receipt: unknown = JSON.parse(await readFile(path, "utf8"));
    if (
      isRecord(receipt) &&
      typeof receipt.reference === "string" &&
      typeof receipt.digest === "string" &&
      typeof receipt.platform === "string" &&
      typeof receipt.imageId === "string" &&
      typeof receipt.archiveHash === "string"
    )
      return receipt as Receipt;
  } catch {}
  return undefined;
}

async function fileHash(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export function sameImageId(actual: string, expected: string): boolean {
  const id = actual.replace(/^sha256:/, "");
  return /^[a-f0-9]{12,64}$/.test(id) && expected.replace(/^sha256:/, "").startsWith(id);
}

function failure(message: string): SandboxError {
  return new SandboxError("SANDBOX_TEMPLATE_UPDATE_FAILED", message);
}
