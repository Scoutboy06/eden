import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { SandboxProfile } from "../config/schema";
import type { SandboxSummary } from "./provider";
import { canonicalReference, propagateCancellation, record } from "./template-sandbox-status";
import {
  cachePaths,
  findTemplate,
  parseReference,
  parseTemplates,
  readReceipt,
  sameImageId,
  sandboxPlatform,
  type TemplateEntry,
  type Receipt,
} from "./template-update";
import { registryDigest, templateCommand } from "../../external/docker-sbx/template-commands";

export type FreshnessState = "current" | "outdated" | "missing" | "unknown";
export type Freshness = { state: FreshnessState; reason: string; image?: string };
type ImageMetadata = { image: string; imageId: string };

export async function checkSandboxFreshness(
  sandboxes: SandboxSummary[],
  profiles: Record<string, SandboxProfile>,
): Promise<{ sandboxes: (SandboxSummary & { freshness: Freshness })[]; warnings: string[] }> {
  const warnings: string[] = [];
  if (sandboxes.length === 0) return { sandboxes: [], warnings };
  let templates: TemplateEntry[] | undefined;
  try {
    templates = parseTemplates(await templateCommand("sbx", ["template", "ls", "--json"]));
  } catch (error) {
    propagateCancellation(error);
    warnings.push("Docker Sandboxes template metadata could not be read.");
  }
  const registry = new Map<string, Promise<string | undefined>>();
  let receiptList: Promise<Receipt[]> | undefined;
  const previousReceipts = () => (receiptList ??= listReceipts());
  const results = [];
  for (const sandbox of sandboxes) {
    const metadata = await inspectSandbox(sandbox.name);
    if (!metadata) {
      results.push({
        ...sandbox,
        freshness: { state: "unknown" as const, reason: "Sandbox image metadata is unavailable." },
      });
      continue;
    }
    const freshness = await checkImage(
      metadata,
      templates,
      profiles,
      registry,
      warnings,
      previousReceipts,
    );
    results.push({ ...sandbox, freshness });
  }
  return { sandboxes: results, warnings };
}

async function inspectSandbox(name: string): Promise<ImageMetadata | undefined> {
  try {
    const data: unknown = JSON.parse(
      await templateCommand("sbx", ["inspect", "--json", "--", name]),
    );
    if (
      !record(data) ||
      typeof data.image !== "string" ||
      typeof data.image_digest !== "string" ||
      !/^sha256:[a-f0-9]{64}$/.test(data.image_digest)
    )
      return undefined;
    return { image: data.image, imageId: data.image_digest };
  } catch (error) {
    propagateCancellation(error);
    return undefined;
  }
}

async function checkImage(
  metadata: ImageMetadata,
  templates: TemplateEntry[] | undefined,
  profiles: Record<string, SandboxProfile>,
  registry: Map<string, Promise<string | undefined>>,
  warnings: string[],
  previousReceipts: () => Promise<Receipt[]>,
): Promise<Freshness> {
  const image = metadata.image;
  let reference: { repository: string; tag: string };
  try {
    reference = parseReference(image);
  } catch {
    return {
      state: "unknown",
      image,
      reason: "The sandbox image reference cannot be compared to a registry tag.",
    };
  }
  if (!templates)
    return { state: "unknown", image, reason: "Loaded template metadata is unavailable." };
  const loaded = findTemplate(templates, reference.repository, reference.tag);
  if (!loaded)
    return {
      state: "missing",
      image,
      reason: "The template is absent from the Docker Sandboxes image store.",
    };

  if (!registry.has(image)) registry.set(image, lookupDigest(image, warnings));
  const digest = await registry.get(image)!;
  if (!digest)
    return { state: "unknown", image, reason: "The registry digest could not be checked." };
  let platform: string;
  try {
    platform = sandboxPlatform();
  } catch {
    return {
      state: "unknown",
      image,
      reason: "The sandbox platform cannot be verified on this machine.",
    };
  }
  return checkReceipts(metadata, loaded, profiles, digest, platform, previousReceipts);
}

async function checkReceipts(
  metadata: ImageMetadata,
  loaded: TemplateEntry,
  profiles: Record<string, SandboxProfile>,
  digest: string,
  platform: string,
  previousReceipts: () => Promise<Receipt[]>,
): Promise<Freshness> {
  const image = metadata.image;
  const candidates = [
    image,
    ...Object.values(profiles).flatMap((profile) =>
      profile.template && canonicalReference(profile.template) === canonicalReference(image)
        ? [profile.template]
        : [],
    ),
  ];
  for (const candidate of new Set(candidates)) {
    const receipt = await readReceipt(cachePaths(candidate, digest, platform).receipt);
    if (
      receipt?.reference !== candidate ||
      receipt.digest !== digest ||
      receipt.platform !== platform ||
      !sameImageId(loaded.id, receipt.imageId)
    )
      continue;
    return sameImageId(receipt.imageId, metadata.imageId)
      ? {
          state: "current",
          image,
          reason: "The sandbox image matches the verified current registry template.",
        }
      : {
          state: "outdated",
          image,
          reason: "The sandbox image differs from the verified current registry template.",
        };
  }
  if (sameImageId(loaded.id, metadata.imageId)) {
    const receipts = await previousReceipts();
    if (
      receipts.some(
        (receipt) =>
          receipt.platform === platform &&
          /^sha256:[a-f0-9]{64}$/.test(receipt.digest) &&
          receipt.digest !== digest &&
          candidates.includes(receipt.reference) &&
          sameImageId(loaded.id, receipt.imageId) &&
          sameImageId(receipt.imageId, metadata.imageId),
      )
    ) {
      return {
        state: "outdated",
        image,
        reason: "The registry manifest has changed since this verified template was loaded.",
      };
    }
  }
  return {
    state: "unknown",
    image,
    reason: sameImageId(loaded.id, metadata.imageId)
      ? "No verified receipt links the registry digest to the loaded template."
      : "The sandbox image differs from the loaded template, whose registry identity is unverified.",
  };
}

async function listReceipts(): Promise<Receipt[]> {
  const directory = cachePaths("", "", "").directory;
  const files = await readdir(directory).catch(() => []);
  const receipts = await Promise.all(
    files
      .filter((file) => /^[a-f0-9]{64}\.json$/.test(file))
      .map((file) => readReceipt(join(directory, file))),
  );
  return receipts.filter((receipt): receipt is Receipt => receipt !== undefined);
}

async function lookupDigest(image: string, warnings: string[]): Promise<string | undefined> {
  try {
    return await registryDigest(image);
  } catch (error) {
    propagateCancellation(error);
    warnings.push(
      `Registry lookup failed for ${image}; check registry access and Docker credentials.`,
    );
    return undefined;
  }
}
