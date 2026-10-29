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
    profile: { type: "string", description: "Configured sandbox profile" },
    image: { type: "string", description: "Container image (overrides profile template)" },
  },

  async run(ctx, { sandbox, output }) {
    const service = await sandbox(ctx.values.provider, ctx.values.profile);
    await service.create({ name: ctx.values.name, image: ctx.values.image });

    output.write({
      data: { sandbox: { provider: service.providerName, name: ctx.values.name } },
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
  description: "Create a sandbox if absent, then attach; start it if stopped",
  args: {
    provider: {
      type: "enum",
      choices: sandboxProviderNames,
      description: "Sandbox provider (overrides profile; defaults to sandbox.default_provider)",
    },
    name: { type: "string", required: true, description: "Sandbox name" },
    profile: { type: "string", description: "Configured profile, only for a new sandbox" },
    image: { type: "string", description: "Image for a new sandbox (overrides profile template)" },
  },

  async run(ctx, { sandbox, output }) {
    const { json, dryRun } = ctx.extensions.eden;

    if (json && !dryRun) {
      throw new SandboxError(
        "SANDBOX_INVALID_INPUT",
        "Interactive sandbox attachment does not support --json. Use --dry-run --json to preview it.",
      );
    }

    const service = await sandbox(ctx.values.provider, ctx.values.profile);
    const exitCode = await service.run({ name: ctx.values.name, image: ctx.values.image });

    if (!dryRun) {
      process.exitCode = exitCode;
      output.raw("");
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
    const service = await sandbox(ctx.values.provider);
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

const list = defineCommand({
  name: "list",
  description: "List sandboxes for a provider",
  args: {
    provider: {
      type: "enum",
      choices: sandboxProviderNames,
      description: "Sandbox provider (defaults to configured sandbox.default_provider)",
    },
  },

  async run(ctx, { sandbox, output }) {
    const service = await sandbox(ctx.values.provider);
    const sandboxes = await service.list();

    output.write({
      data: { sandboxes },
      human: () => formatSandboxes(sandboxes),
    });
  },
});

export default defineCommand({
  name: "sbx",
  description: "Manage sandboxes",
  subCommands: { create, run, list, stop },
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
