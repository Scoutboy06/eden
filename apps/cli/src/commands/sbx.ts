import { defineCommand } from "../../../../src/modules/cli";
import {
  sandboxProviderNames,
  type SandboxProviderName,
  type SandboxSummary,
} from "../../../../src/modules/sandbox/provider";
import { SandboxError } from "../../../../src/modules/sandbox/errors";
import { confirm } from "../../../../src/modules/cli/confirm";
import { formatMessage } from "../../../../src/modules/cli/format";
import type { SnapshotResult } from "../../../../src/modules/sandbox/sandbox-snapshot";
import type { SandboxSnapshot } from "../../../../src/modules/sandbox/snapshot-store";
import type { Freshness } from "../../../../src/modules/sandbox/template-freshness";
import type { SandboxService } from "../../../../src/modules/sandbox/sandbox.service";
import { deriveSandboxName, findCheckout } from "../../../../src/modules/sandbox/sandbox-checkout";

const create = defineCommand({
  name: "create",
  description: "Create a sandbox without entering it",
  args: {
    provider: {
      type: "enum",
      choices: sandboxProviderNames,
      description: "Sandbox provider (overrides profile; defaults to sandbox.default_provider)",
    },
    name: {
      type: "string",
      description: "Sandbox name (defaults to a name derived from the current checkout folder)",
    },
    profile: {
      type: "string",
      description: "Sandbox profile (defaults to sandbox.default_profile)",
    },
    image: { type: "string", description: "Container image (overrides profile template)" },
    path: { type: "string", description: "Workspace path (overrides profile workspace path)" },
  },

  async run(ctx, { sandbox, output }) {
    const name = ctx.values.name ?? deriveSandboxName(await findCheckout(process.cwd()));
    if (ctx.values.name === undefined && !ctx.extensions.eden.json) {
      process.stderr.write(`Using sandbox name ${name}, derived from the current checkout.
`);
    }

    const service = await sandbox({
      provider: ctx.values.provider,
      profile: ctx.values.profile,
      useDefaultProfile: true,
    });
    const { warnings } = await service.create({ name, image: ctx.values.image }, ctx.values.path);

    output.write({
      data: {
        sandbox: { provider: service.providerName, name },
        ...(warnings.length ? { warnings } : {}),
      },
      human: () => formatCreatedSandbox(name, service.providerName),
    });
  },
});

const run = defineCommand({
  name: "run",
  description: "Attach to an existing sandbox; start it if stopped",
  args: {
    provider: {
      type: "enum",
      choices: sandboxProviderNames,
      description: "Sandbox provider (defaults to configured sandbox.default_provider)",
    },
    name: {
      type: "string",
      description: "Sandbox name (defaults to the sandbox for the current checkout)",
    },
  },

  async run(ctx, { sandbox, output }) {
    const { json, dryRun } = ctx.extensions.eden;

    if (json && !dryRun) {
      throw new SandboxError(
        "SANDBOX_INVALID_INPUT",
        "Interactive sandbox attachment does not support --json. Use --dry-run --json to preview it.",
      );
    }

    const service = await sandbox({ provider: ctx.values.provider });
    const name = await selectName(ctx.values.name, service, json);
    const exitCode = await service.run({ name });

    if (!dryRun) {
      process.exitCode = exitCode;
      output.raw("");
    }
  },
});

const exec = defineCommand({
  name: "exec",
  description: "Execute a command in an existing sandbox",
  args: {
    provider: {
      type: "enum",
      choices: sandboxProviderNames,
      description: "Sandbox provider (defaults to configured sandbox.default_provider)",
    },
    name: {
      type: "string",
      description: "Sandbox name (defaults to the sandbox for the current checkout)",
    },
  },
  async run(ctx, { sandbox, output }) {
    const { json } = ctx.extensions.eden;
    const service = await sandbox({ provider: ctx.values.provider });
    const name = await selectName(ctx.values.name, service, json);
    const result = await service.exec({
      name,
      argv: ctx.rest,
      output: json ? "capture" : "inherit",
    });
    if (result) {
      process.exitCode = result.exitCode;
      if (json) output.write({ data: { result }, human: () => "" });
      else output.raw("");
    }
  },
});

const shell = defineCommand({
  name: "shell",
  description: "Open an interactive login shell in a sandbox; start it if stopped",
  args: {
    provider: {
      type: "enum",
      choices: sandboxProviderNames,
      description: "Sandbox provider (defaults to configured sandbox.default_provider)",
    },
    name: {
      type: "string",
      description: "Sandbox name (defaults to the sandbox for the current checkout)",
    },
    profile: {
      type: "string",
      description: "Sandbox profile for shell settings (defaults to the profile that created it)",
    },
    cwd: {
      type: "string",
      description: "Start folder inside the sandbox (overrides profile shell.cwd)",
    },
  },

  async run(ctx, { sandbox }) {
    const { json, dryRun } = ctx.extensions.eden;

    if (json && !dryRun) {
      throw new SandboxError(
        "SANDBOX_INVALID_INPUT",
        "Interactive sandbox shells do not support --json. Use --dry-run --json to preview it.",
      );
    }

    const lookup = await sandbox({ provider: ctx.values.provider });
    const name = await selectName(ctx.values.name, lookup, json);
    const service = await shellService(sandbox, lookup, name, ctx.values.profile);
    const result = await service.shell({ name, cwd: ctx.values.cwd });

    if (result && !dryRun) process.exitCode = result.exitCode;
  },
});

const start = defineCommand({
  name: "start",
  description: "Start an existing sandbox without attaching to it",
  args: {
    provider: {
      type: "enum",
      choices: sandboxProviderNames,
      description: "Sandbox provider (defaults to configured sandbox.default_provider)",
    },
    name: {
      type: "string",
      description: "Sandbox name (defaults to the sandbox for the current checkout)",
    },
  },

  async run(ctx, { sandbox, output }) {
    const service = await sandbox({ provider: ctx.values.provider });
    const name = await selectName(ctx.values.name, service, ctx.extensions.eden.json);
    const { started } = await service.start(name);

    output.write({
      data: { sandbox: { provider: service.providerName, name }, started },
      human: () =>
        formatMessage(
          started
            ? `Sandbox ${name} is running using ${service.providerName}.`
            : `Sandbox ${name} is already running using ${service.providerName}.`,
          "success",
          "stdout",
        ),
    });
  },
});

const stop = defineCommand({
  name: "stop",
  description: "Stop a named sandbox without removing it or its data",
  args: {
    provider: {
      type: "enum",
      choices: sandboxProviderNames,
      description: "Sandbox provider (defaults to configured sandbox.default_provider)",
    },
    name: { type: "string", required: true, description: "Sandbox name" },
  },

  async run(ctx, { sandbox, output }) {
    const service = await sandbox({ provider: ctx.values.provider });
    await service.stop(ctx.values.name);

    output.write({
      data: { sandbox: { provider: service.providerName, name: ctx.values.name } },
      human: () =>
        formatMessage(
          `Sandbox ${ctx.values.name} is stopped using ${service.providerName}. Its data is preserved.`,
          "success",
          "stdout",
        ),
    });
  },
});

const ssh = defineCommand({
  name: "ssh",
  description: "Print how to connect to a named sandbox over ssh",
  args: {
    provider: {
      type: "enum",
      choices: sandboxProviderNames,
      description: "Sandbox provider (defaults to configured sandbox.default_provider)",
    },
    name: { type: "string", required: true, description: "Sandbox name" },
  },

  async run(ctx, { sandbox, output }) {
    const service = await sandbox({ provider: ctx.values.provider });
    const access = await service.ssh(ctx.values.name);

    output.write({
      data: {
        sandbox: { provider: service.providerName, name: ctx.values.name, status: access.status },
        ssh: { host: access.host, command: access.command, setupCommand: access.setupCommand },
      },
      human: () => formatSshAccess(ctx.values.name, service.providerName, access),
    });
  },
});

const remove = defineCommand({
  name: "rm",
  description: "Remove one sandbox and its data",
  args: {
    provider: {
      type: "enum",
      choices: sandboxProviderNames,
      description: "Sandbox provider (defaults to configured sandbox.default_provider)",
    },
    name: {
      type: "string",
      description: "Sandbox name (defaults to the sandbox for the current checkout)",
    },
    force: {
      type: "boolean",
      description: "Skip removal hook and confirmation; allow running sandbox removal",
    },
    yes: {
      type: "boolean",
      short: "y",
      description: "Skip confirmation; still run the removal hook",
    },
  },
  async run(ctx, { sandbox, output }) {
    const { json, dryRun } = ctx.extensions.eden;
    const force = ctx.values.force ?? false;
    const yes = ctx.values.yes ?? false;
    if (ctx.values.name === undefined && ctx.values.force) {
      throw new SandboxError(
        "SANDBOX_INVALID_INPUT",
        "Removing an inferred sandbox cannot use --force. Pass --name to remove a sandbox without confirmation.",
      );
    }
    if (
      !force &&
      !yes &&
      !dryRun &&
      (json || !process.stdin.isTTY || !process.stdout.isTTY || !process.stderr.isTTY)
    ) {
      throw new SandboxError(
        "SANDBOX_REMOVE_REQUIRES_FORCE",
        "Noninteractive sandbox removal requires --yes or --force; without either, run in a terminal to confirm removal.",
      );
    }
    const service = await sandbox({ provider: ctx.values.provider });
    const name = await selectName(ctx.values.name, service, json);
    if (ctx.values.name === undefined && !dryRun && !yes && !(await confirmRemoval(name))) {
      throw new SandboxError("CANCELLED", `Removal of sandbox ${name} was not confirmed.`);
    }
    await service.remove(name, { force, skipConfirmation: yes });
    output.write({
      data: { sandbox: { provider: service.providerName, name } },
      human: () => `Removed sandbox ${name} using ${service.providerName}.`,
    });
  },
});

const list = defineCommand({
  name: "list",
  description: "List sandboxes for a provider",
  args: {
    provider: {
      type: "enum",
      choices: sandboxProviderNames,
      description: "Sandbox provider (defaults to configured sandbox.default_provider)",
    },
    "check-updates": { type: "boolean", description: "Check image freshness against registries" },
  },

  async run(ctx, { sandbox, output, readResolvedConfig, checkSandboxFreshness }) {
    const service = await sandbox({ provider: ctx.values.provider });
    const sandboxes = await service.list();
    if (ctx.values["check-updates"]) {
      const config = await readResolvedConfig();
      const result = await checkSandboxFreshness(sandboxes, config.config.sandbox?.profiles ?? {});
      output.write({
        data: result,
        human: () => formatFreshSandboxList(result),
      });
      return;
    }

    output.write({
      data: { sandboxes },
      human: () => formatSandboxes(sandboxes),
    });
  },
});

const status = defineCommand({
  name: "status",
  description: "Show a sandbox's state, workspace, profile, image freshness and latest snapshot",
  args: {
    provider: {
      type: "enum",
      choices: sandboxProviderNames,
      description: "Sandbox provider (defaults to configured sandbox.default_provider)",
    },
    name: {
      type: "string",
      description: "Sandbox name (defaults to the sandbox for the current checkout)",
    },
    "check-updates": {
      type: "boolean",
      negatable: true,
      default: true,
      description: "Check image freshness against the registry (--no-check-updates skips it)",
    },
  },

  async run(ctx, { sandbox, output, readResolvedConfig, checkSandboxFreshness }) {
    const service = await sandbox({ provider: ctx.values.provider });
    const name = await selectName(ctx.values.name, service, ctx.extensions.eden.json);
    const { sandbox: summary, latestSnapshot } = await service.status(name);

    let freshness: Freshness = { state: "unknown", reason: "Not checked (--no-check-updates)." };
    let warnings: string[] = [];

    if (ctx.values["check-updates"]) {
      const config = await readResolvedConfig();
      const result = await checkSandboxFreshness([summary], config.config.sandbox?.profiles ?? {});
      freshness = result.sandboxes[0]!.freshness;
      warnings = result.warnings;
    }

    output.write({
      data: {
        sandbox: summary,
        freshness,
        latestSnapshot: latestSnapshot ?? null,
        ...(warnings.length ? { warnings } : {}),
      },
      human: () => formatStatus(summary, freshness, latestSnapshot, warnings),
    });
  },
});

const rebuild = defineCommand({
  name: "rebuild",
  description: "Remove a sandbox and recreate it from its profile, keeping its snapshot paths",
  args: {
    provider: {
      type: "enum",
      choices: sandboxProviderNames,
      description: "Sandbox provider (defaults to configured sandbox.default_provider)",
    },
    name: {
      type: "string",
      description: "Sandbox name (defaults to the sandbox for the current checkout)",
    },
    profile: {
      type: "string",
      description: "Sandbox profile to recreate from (defaults to the profile that created it)",
    },
    image: { type: "string", description: "Container image (overrides profile template)" },
    path: { type: "string", description: "Workspace path (overrides profile workspace path)" },
    force: {
      type: "boolean",
      description: "Skip removal hook and confirmation; allow rebuilding a running sandbox",
    },
    snapshot: {
      type: "boolean",
      negatable: true,
      default: true,
      description: "Snapshot the profile snapshot paths first (--no-snapshot skips it)",
    },
    restore: {
      type: "boolean",
      negatable: true,
      default: true,
      description: "Restore the new snapshot afterwards (--no-restore skips it)",
    },
  },

  async run(ctx, { sandbox, output }) {
    const { json, dryRun } = ctx.extensions.eden;

    if (ctx.values.name === undefined && ctx.values.force) {
      throw new SandboxError(
        "SANDBOX_INVALID_INPUT",
        "Rebuilding an inferred sandbox cannot use --force. Pass --name to rebuild a sandbox without confirmation.",
      );
    }

    if (
      !ctx.values.force &&
      !dryRun &&
      (json || !process.stdin.isTTY || !process.stdout.isTTY || !process.stderr.isTTY)
    ) {
      throw new SandboxError(
        "SANDBOX_REMOVE_REQUIRES_FORCE",
        "Noninteractive sandbox rebuilds require --force; without it, run in a terminal to confirm removal.",
      );
    }

    const lookup = await sandbox({ provider: ctx.values.provider });
    const name = await selectName(ctx.values.name, lookup, json);

    if (ctx.values.name === undefined && !dryRun && !(await confirmRebuild(name))) {
      throw new SandboxError("CANCELLED", `Rebuild of sandbox ${name} was not confirmed.`);
    }

    const service = await shellService(sandbox, lookup, name, ctx.values.profile);
    const result = await service.rebuild({
      name,
      force: ctx.values.force ?? false,
      snapshot: ctx.values.snapshot,
      restore: ctx.values.restore,
      image: ctx.values.image,
      path: ctx.values.path,
    });

    output.write({
      data: {
        sandbox: { provider: service.providerName, name },
        restored: result.restored,
        ...(result.snapshot ? { snapshot: result.snapshot } : {}),
        ...(result.warnings.length ? { warnings: result.warnings } : {}),
      },
      human: () => formatRebuilt(name, service.providerName, result),
    });
  },
});

const refreshKit = defineCommand({
  name: "refresh-kit",
  description:
    "(Experimental, uses sbx kit add) Add the profile's kits to an existing sandbox; re-adding a present kit may duplicate it",
  args: {
    provider: {
      type: "enum",
      choices: sandboxProviderNames,
      description: "Sandbox provider (defaults to configured sandbox.default_provider)",
    },
    name: {
      type: "string",
      description: "Sandbox name (defaults to the sandbox for the current checkout)",
    },
    profile: {
      type: "string",
      description: "Sandbox profile to take kits from (defaults to the profile that created it)",
    },
    kit: {
      type: "string",
      multiple: true,
      description: "Kit path or reference to add instead of the profile kits (repeatable)",
    },
  },

  async run(ctx, { sandbox, output }) {
    const lookup = await sandbox({ provider: ctx.values.provider });
    const name = await selectName(ctx.values.name, lookup, ctx.extensions.eden.json);
    const service = await shellService(sandbox, lookup, name, ctx.values.profile);
    const { kits } = await service.refreshKits({ name, kits: ctx.values.kit });

    output.write({
      data: { sandbox: { provider: service.providerName, name }, kits },
      human: () =>
        formatMessage(
          [
            `Added ${kits.length} kit(s) to sandbox ${name}:`,
            ...kits.map((kit) => `  ${kit}`),
          ].join("\n"),
          "success",
          "stdout",
        ),
    });
  },
});

const snapshot = defineCommand({
  name: "snapshot",
  description: "Archive a sandbox's profile snapshot paths to the host; --list shows snapshots",
  args: {
    provider: {
      type: "enum",
      choices: sandboxProviderNames,
      description: "Sandbox provider (defaults to configured sandbox.default_provider)",
    },
    name: {
      type: "string",
      description: "Sandbox name (defaults to the sandbox for the current checkout)",
    },
    profile: {
      type: "string",
      description:
        "Sandbox profile for snapshot settings (defaults to the profile that created it)",
    },
    list: {
      type: "boolean",
      description: "List the snapshots of the sandbox instead of taking one",
    },
  },

  async run(ctx, { sandbox, output }) {
    const { json } = ctx.extensions.eden;
    const lookup = await sandbox({ provider: ctx.values.provider });
    const name = await selectName(ctx.values.name, lookup, json);

    if (ctx.values.list) {
      const snapshots = await lookup.snapshots(name);
      output.write({
        data: { sandbox: { provider: lookup.providerName, name }, snapshots },
        human: () => formatSnapshots(name, snapshots),
      });
      return;
    }

    const service = await shellService(sandbox, lookup, name, ctx.values.profile);
    const result = await service.snapshot(name);
    output.write({
      data: { sandbox: { provider: service.providerName, name }, ...result },
      human: () => formatTakenSnapshot(name, result),
    });
  },
});

const restore = defineCommand({
  name: "restore",
  description: "Restore a snapshot into a sandbox's home folder",
  args: {
    provider: {
      type: "enum",
      choices: sandboxProviderNames,
      description: "Sandbox provider (defaults to configured sandbox.default_provider)",
    },
    name: {
      type: "string",
      description: "Sandbox name (defaults to the sandbox for the current checkout)",
    },
    snapshot: {
      type: "string",
      description: "Snapshot id from eden sbx snapshot --list, or latest (default)",
    },
  },

  async run(ctx, { sandbox, output }) {
    const service = await sandbox({ provider: ctx.values.provider });
    const name = await selectName(ctx.values.name, service, ctx.extensions.eden.json);
    const { snapshot } = await service.restore(name, ctx.values.snapshot);

    output.write({
      data: { sandbox: { provider: service.providerName, name }, snapshot },
      human: () =>
        formatMessage(
          `Restored snapshot ${snapshot.id} into sandbox ${name}.`,
          "success",
          "stdout",
        ),
    });
  },
});

export default defineCommand({
  name: "sbx",
  description: "Manage sandboxes",
  subCommands: {
    create,
    run,
    start,
    exec,
    shell,
    list,
    stop,
    ssh,
    rebuild,
    "refresh-kit": refreshKit,
    status,
    snapshot,
    restore,
    rm: remove,
  },
});

function confirmRemoval(name: string): Promise<boolean> {
  return confirm(`Remove sandbox ${name} and its data? [y/N] `);
}

function confirmRebuild(name: string): Promise<boolean> {
  return confirm(`Remove sandbox ${name} and its data, then recreate it from its profile? [y/N] `);
}

async function selectName(
  explicit: string | undefined,
  service: SandboxService,
  json: boolean,
): Promise<string> {
  if (explicit !== undefined) return explicit;

  const inferred = await service.infer(process.cwd());
  if (!json) {
    const reason =
      inferred.source === "workspace"
        ? "its workspace is the current checkout"
        : "its name matches the current checkout folder";
    process.stderr.write(`Using sandbox ${inferred.name} because ${reason}.\n`);
  }

  return inferred.name;
}

async function shellService(
  sandbox: (selection: {
    provider?: SandboxProviderName;
    profile?: string;
  }) => Promise<SandboxService>,
  lookup: SandboxService,
  name: string,
  explicitProfile: string | undefined,
): Promise<SandboxService> {
  const provider = lookup.providerName;

  if (explicitProfile !== undefined) return sandbox({ provider, profile: explicitProfile });

  const remembered = await lookup.profileOf(name);
  if (remembered === undefined) return lookup;

  try {
    return await sandbox({ provider, profile: remembered });
  } catch (error) {
    if (error instanceof SandboxError && error.code === "SANDBOX_PROFILE_NOT_FOUND") return lookup;
    throw error;
  }
}

function quoteShellArgument(value: string): string {
  if (/^[a-zA-Z0-9_./-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function formatSshAccess(
  name: string,
  provider: string,
  access: { host: string; command: string[]; setupCommand: string[]; status: string },
): string {
  const lines = [
    `Connect to sandbox ${name} over ssh:`,
    `  ${access.command.map(quoteShellArgument).join(" ")}`,
    "",
    "Editors (for example VS Code Remote-SSH) can connect to the host:",
    `  ${access.host}`,
    "",
    "If the host is not known to your ssh client, run once:",
    `  ${access.setupCommand.map(quoteShellArgument).join(" ")}`,
  ];
  if (access.status !== "running") {
    lines.push(
      "",
      `Sandbox ${name} is ${access.status}; start it with: eden sbx run --provider ${provider} --name ${quoteShellArgument(name)}`,
    );
  }

  return formatMessage(lines.join("\n"), "success", "stdout");
}

function formatCreatedSandbox(name: string, provider: string): string {
  const quotedName = quoteShellArgument(name);
  const message = `Created sandbox ${name} using ${provider}.\n\nAttach with Eden:\n  eden sbx run --provider ${provider} --name ${quotedName}`;

  return formatMessage(message, "success", "stdout");
}

function formatRebuilt(
  name: string,
  provider: string,
  result: { snapshot?: SandboxSnapshot; restored: boolean },
): string {
  const lines = [`Rebuilt sandbox ${name} using ${provider}.`];
  if (result.snapshot) {
    const action = result.restored ? "Restored" : "Kept";
    lines.push(`  ${action} snapshot ${result.snapshot.id}: ${result.snapshot.path}`);
  }

  return formatMessage(lines.join("\n"), "success", "stdout");
}

function formatTakenSnapshot(name: string, result: SnapshotResult | undefined): string {
  if (result === undefined) return "";

  const lines = [
    `Snapshot ${result.snapshot.id} of sandbox ${name} saved (${formatSize(result.snapshot.sizeBytes)}).`,
    `  ${result.snapshot.path}`,
    `  Archived: ${result.archived.join(", ")}`,
  ];
  if (result.skipped.length > 0) lines.push(`  Skipped (not found): ${result.skipped.join(", ")}`);
  if (result.pruned.length > 0) lines.push(`  Pruned ${result.pruned.length} older snapshot(s).`);

  return formatMessage(lines.join("\n"), "success", "stdout");
}

function formatStatus(
  sandbox: SandboxSummary,
  freshness: Freshness,
  latestSnapshot: SandboxSnapshot | undefined,
  warnings: readonly string[],
): string {
  const lines = [
    `Sandbox ${sandbox.name} (${sandbox.provider})`,
    `  State:     ${sandbox.status}`,
    `  Workspace: ${sandbox.workspace ?? "-"}`,
    `  Profile:   ${sandbox.profile ?? "-"}`,
    `  Image:     ${freshness.state} - ${freshness.reason}`,
    `  Snapshot:  ${latestSnapshot ? `${latestSnapshot.id} (${latestSnapshot.createdAt}, ${formatSize(latestSnapshot.sizeBytes)})` : "none"}`,
    ...warnings.map((warning) => `Warning: ${warning}`),
  ];

  return lines.join("\n");
}

function formatSnapshots(name: string, snapshots: readonly SandboxSnapshot[]): string {
  if (snapshots.length === 0) return `No snapshots found for sandbox ${name}.`;

  return [
    "ID  CREATED  SIZE",
    ...snapshots.map(
      ({ id, createdAt, sizeBytes }) => `${id}  ${createdAt}  ${formatSize(sizeBytes)}`,
    ),
  ].join("\n");
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;

  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function formatFreshSandboxList(result: {
  sandboxes: Array<SandboxSummary & { freshness: { state: string; reason: string } }>;
  warnings: string[];
}): string {
  const table = formatSandboxes(result.sandboxes);
  const freshness = result.sandboxes
    .map((entry) => {
      const profile = entry.profile ? ` (profile ${entry.profile})` : "";

      return `\n  ${entry.name}${profile}: ${entry.freshness.state} — ${entry.freshness.reason}`;
    })
    .join("");
  const warnings = result.warnings.map((warning) => `\nWarning: ${warning}`).join("");

  return `${table}${freshness}${warnings}`;
}

function formatSandboxes(sandboxes: readonly SandboxSummary[]): string {
  if (sandboxes.length === 0) return "No sandboxes found.";

  const showProfile = sandboxes.some(({ profile }) => profile !== undefined);
  const header = ["NAME", "STATUS", "PROVIDER", ...(showProfile ? ["PROFILE"] : [])];
  const rows = [
    header,
    ...sandboxes.map(({ name, status, provider, profile }) => [
      name,
      status,
      provider,
      ...(showProfile ? [profile ?? "-"] : []),
    ]),
  ];
  const widths = header.map((_, column) => Math.max(...rows.map((row) => row[column]!.length)));

  return rows
    .map((row) =>
      row
        .map((value, column) => value.padEnd(widths[column]!))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}
