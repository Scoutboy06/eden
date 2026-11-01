import { SandboxError } from "./errors";

export type TemplateSandboxAssessment = {
  current: string[];
  outdated: string[];
  unattributed: string[];
  unavailable: string[];
  listUnavailable: boolean;
};

export async function assessTemplateSandboxes(
  reference: string,
  imageId: string,
  run: (args: string[]) => Promise<string>,
): Promise<TemplateSandboxAssessment> {
  const assessment: TemplateSandboxAssessment = {
    current: [],
    outdated: [],
    unattributed: [],
    unavailable: [],
    listUnavailable: false,
  };
  let names: string[];
  try {
    const data: unknown = JSON.parse(await run(["ls", "--json"]));
    const entries = Array.isArray(data)
      ? data
      : record(data) && Array.isArray(data.sandboxes)
        ? data.sandboxes
        : undefined;
    if (
      !entries ||
      !entries.every((entry: unknown) => record(entry) && typeof entry.name === "string")
    )
      throw new Error("Invalid sandbox listing");
    names = entries.map((entry: { name: string }) => entry.name);
  } catch (error) {
    propagateCancellation(error);
    assessment.listUnavailable = true;
    return assessment;
  }

  for (const name of names) {
    try {
      const data: unknown = JSON.parse(await run(["inspect", "--json", "--", name]));
      assessment[classify(data, reference, imageId)].push(name);
    } catch (error) {
      propagateCancellation(error);
      assessment.unavailable.push(name);
    }
  }
  return assessment;
}

function classify(
  data: unknown,
  reference: string,
  imageId: string,
): "current" | "outdated" | "unattributed" | "unavailable" {
  if (
    !record(data) ||
    typeof data.image !== "string" ||
    typeof data.image_digest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(data.image_digest)
  )
    return "unavailable";
  if (canonicalReference(data.image) !== canonicalReference(reference)) return "unattributed";
  return data.image_digest.slice(7).startsWith(imageId.replace(/^sha256:/, ""))
    ? "current"
    : "outdated";
}

export function canonicalReference(reference: string): string {
  const slash = reference.lastIndexOf("/");
  const colon = reference.lastIndexOf(":");
  const repository = colon > slash ? reference.slice(0, colon) : reference;
  const tag = colon > slash ? reference.slice(colon + 1) : "latest";
  const parts = repository.split("/");
  if (!parts[0]!.includes(".") && !parts[0]!.includes(":") && parts[0] !== "localhost")
    parts.unshift("docker.io");
  if (parts[0] === "docker.io" && parts.length === 2) parts.splice(1, 0, "library");
  return `${parts.join("/")}:${tag}`;
}

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function propagateCancellation(error: unknown): void {
  if (error instanceof SandboxError && error.code === "CANCELLED") throw error;
}
