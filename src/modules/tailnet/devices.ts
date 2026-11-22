import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import * as v from "valibot";

export type TailnetDevice = {
  sandboxName: string;
  nodeId: string;
  dnsName: string;
  sshUser: string;
  pendingCleanup?: boolean;
};

export type TailnetDeviceStoreOptions = {
  stateHome?: string;
  home?: string;
};

const deviceSchema = v.strictObject({
  sandboxName: v.pipe(v.string(), v.nonEmpty()),
  nodeId: v.pipe(v.string(), v.nonEmpty()),
  dnsName: v.pipe(v.string(), v.nonEmpty()),
  sshUser: v.pipe(v.string(), v.nonEmpty()),
  pendingCleanup: v.optional(v.boolean()),
});

export function createTailnetDeviceStore(options: TailnetDeviceStoreOptions = {}) {
  const directory = join(
    options.stateHome ??
      process.env.XDG_STATE_HOME ??
      join(options.home ?? homedir(), ".local", "state"),
    "eden",
    "tailnet",
    "devices",
  );

  return {
    async read(sandboxName: string): Promise<TailnetDevice | undefined> {
      try {
        const content = await readFile(devicePath(directory, sandboxName), "utf8");
        return parseDevice(JSON.parse(content), sandboxName);
      } catch (error) {
        if (isMissingFile(error)) return undefined;
        throw error;
      }
    },

    async write(device: TailnetDevice): Promise<void> {
      const validated = parseDevice(device, device.sandboxName);
      await mkdir(directory, { recursive: true });
      const path = devicePath(directory, validated.sandboxName);
      const temporaryPath = `${path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporaryPath, `${JSON.stringify(validated, null, 2)}\n`, { mode: 0o600 });
        await rename(temporaryPath, path);
      } finally {
        await rm(temporaryPath, { force: true });
      }
    },

    async delete(sandboxName: string): Promise<void> {
      await rm(devicePath(directory, sandboxName), { force: true });
    },

    async list(): Promise<TailnetDevice[]> {
      let files: string[];
      try {
        files = await readdir(directory);
      } catch (error) {
        if (isMissingFile(error)) return [];
        throw error;
      }
      const devices = await Promise.all(
        files
          .filter((file) => file.endsWith(".json"))
          .map(async (file) => {
            const content = await readFile(join(directory, file), "utf8");
            return parseDevice(JSON.parse(content));
          }),
      );
      return devices.sort((left, right) => left.sandboxName.localeCompare(right.sandboxName));
    },
  };
}

function parseDevice(value: unknown, expectedSandboxName?: string): TailnetDevice {
  const result = v.safeParse(deviceSchema, value);
  if (!result.success) throw new Error("Tailnet device state is invalid.");
  if (expectedSandboxName !== undefined && result.output.sandboxName !== expectedSandboxName)
    throw new Error("Tailnet device sandbox name does not match its record.");
  return result.output;
}

function devicePath(directory: string, sandboxName: string): string {
  if (!sandboxName) throw new Error("Sandbox name must not be empty.");
  const key = createHash("sha256").update(sandboxName).digest("hex");
  return join(directory, `${key}.json`);
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
