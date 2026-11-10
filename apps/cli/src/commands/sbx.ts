import { defineCommand } from "../../../../src/modules/cli";
import {
  sandboxProviderNames,
  type SandboxSummary,
} from "../../../../src/modules/sandbox/provider";
import { SandboxError } from "../../../../src/modules/sandbox/errors";
import { formatMessage } from "../../../../src/modules/cli/format";

const create = defineCommand({
  name: "create",
  description: "Create a sandbox without entering it",
  args: {
    provider: {
      type: "enum",
      choices: sandboxProviderNames,
      description: "Sandbox provider (overrides profile; defaults to sandbox.default_provider)",
    },
    name: { type: "string", required: true, description: "Sandbox name" },
    profile: {
      type: "string",
      description: "Sandbox profile (defaults to sandbox.default_profile)",
    },
    image: { type: "string", description: "Container image (overrides profile template)" },
    path: { type: "string", description: "Workspace path (overrides profile workspace path)" },
  },

  async run(ctx, { sandbox, output }) {
    const service = await sandbox({
      provider: ctx.values.provider,
      profile: ctx.values.profile,
      useDefaultProfile: true,
    });
    const { warnings } = await service.create(
      { name: ctx.values.name, image: ctx.values.image },
      ctx.values.path,
    );

    output.write({
      data: {
        sandbox: { provider: service.providerName, name: ctx.values.name },
        ...(warnings.length ? { warnings } : {}),
      },
      human: () =>
        formatMessage(
          `Created sandbox ${ctx.values.name} using ${service.providerName}.\n\nAttach with Eden:\n  eden sbx run --provider ${service.providerName} --name ${quoteShellArgument(ctx.values.name)}`,
          "success",
          "stdout",
        ),
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
    name: { type: "string", required: true, description: "Sandbox name" },
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
    const exitCode = await service.run({ name: ctx.values.name });

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
    name: { type: "string", required: true, description: "Sandbox name" },
  },
  async run(ctx, { sandbox, output }) {
    const { json } = ctx.extensions.eden;
    const service = await sandbox({ provider: ctx.values.provider });
    const result = await service.exec({
      name: ctx.values.name,
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

const remove = defineCommand({
  name: "rm",
  description: "Remove one sandbox and its data",
  args: {
    provider: {
      type: "enum",
      choices: sandboxProviderNames,
      description: "Sandbox provider (defaults to configured sandbox.default_provider)",
    },
    name: { type: "string", required: true, description: "Sandbox name" },
    force: {
      type: "boolean",
      description: "Skip removal hook and confirmation; allow running sandbox removal",
    },
  },
  async run(ctx, { sandbox, output }) {
    const { json, dryRun } = ctx.extensions.eden;
    if (
      !ctx.values.force &&
      !dryRun &&
      (json || !process.stdin.isTTY || !process.stdout.isTTY || !process.stderr.isTTY)
    ) {
      throw new SandboxError(
        "SANDBOX_REMOVE_REQUIRES_FORCE",
        "Noninteractive sandbox removal requires --force; without it, run in a terminal to confirm removal.",
      );
    }
    const service = await sandbox({ provider: ctx.values.provider });
    await service.remove(ctx.values.name, ctx.values.force ?? false);
    output.write({
      data: { sandbox: { provider: service.providerName, name: ctx.values.name } },
      human: () => `Removed sandbox ${ctx.values.name} using ${service.providerName}.`,
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
        human: () =>
          `${formatSandboxes(result.sandboxes)}${result.sandboxes.map((entry) => `\n  ${entry.name}: ${entry.freshness.state} — ${entry.freshness.reason}`).join("")}${result.warnings.map((warning) => `\nWarning: ${warning}`).join("")}`,
      });
      return;
    }

    output.write({
      data: { sandboxes },
      human: () => formatSandboxes(sandboxes),
    });
  },
});

export default defineCommand({
  name: "sbx",
  description: "Manage sandboxes",
  subCommands: { create, run, exec, list, stop, rm: remove },
});

function quoteShellArgument(value: string): string {
  return /^[a-zA-Z0-9_./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

function formatSandboxes(sandboxes: readonly SandboxSummary[]): string {
  if (sandboxes.length === 0) return "No sandboxes found.";

  const rows = [
    ["NAME", "STATUS", "PROVIDER"],
    ...sandboxes.map(({ name, status, provider }) => [name, status, provider]),
  ];
  const widths = [0, 1, 2].map((column) => Math.max(...rows.map((row) => row[column]!.length)));

  return rows
    .map((row) =>
      row
        .map((value, column) => value.padEnd(widths[column]!))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}
