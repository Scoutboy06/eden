import { defineCommand } from "../../../../src/modules/cli";
import { describeProfile, listProfiles } from "../../../../src/modules/sandbox/profiles";

const list = defineCommand({
  name: "list",
  description: "List effective sandbox profiles and their configuration sources",
  async run(_ctx, { readResolvedConfig, output }) {
    const profiles = listProfiles(await readResolvedConfig());

    output.write({
      data: { profiles },
      human: () => formatProfileList(profiles),
    });
  },
});

const show = defineCommand({
  name: "show",
  description: "Show an effective sandbox profile and field provenance",
  args: { name: { type: "positional", required: true, description: "Profile name" } },
  async run(ctx, { readResolvedConfig, output }) {
    const profile = describeProfile(await readResolvedConfig(), ctx.values.name);

    output.write({
      data: { profile },
      human: () => formatProfile(profile),
    });
  },
});

const updateTemplate = defineCommand({
  name: "update-template",
  description: "Update a profile template from its registry",
  args: { name: { type: "positional", required: true, description: "Profile name" } },
  async run(ctx, { readResolvedConfig, templateUpdate, output }) {
    const profile = describeProfile(await readResolvedConfig(), ctx.values.name);
    const result = await templateUpdate.update(
      profile.name,
      profile.profile,
      profile.provider ?? undefined,
    );
    output.write({
      data: { template: result },
      human: () => {
        const sandbox = result.sandboxes;
        if (!sandbox)
          return `Template ${result.template} is ${result.status} at ${result.digest}. Sandbox status will be inspected after loading.`;
        const warning = sandbox.listUnavailable ? " Sandbox listing was unavailable." : "";
        return `Template ${result.template} is ${result.status} at ${result.digest}.\nOutdated sandboxes: ${sandbox.outdated.join(", ") || "none identified"}\nUnattributed: ${sandbox.unattributed.join(", ") || "none"}\nInspection unavailable: ${sandbox.unavailable.join(", ") || "none"}${warning}`;
      },
    });
  },
});

export default defineCommand({
  name: "profile",
  description: "Inspect sandbox profiles",
  subCommands: { list, show, "update-template": updateTemplate },
});

function formatProfileList(profiles: ReturnType<typeof listProfiles>): string {
  if (profiles.length === 0) return "No sandbox profiles configured.";
  return profiles.map(formatProfileListItem).join("\n");
}

function formatProfileListItem(profile: ReturnType<typeof listProfiles>[number]): string {
  const provider = profile.provider ?? "(no provider)";
  const sources = profile.sources.join(", ") || "no recorded fields";
  const providerSource = formatProviderSource(profile.providerSource, "\n  Default provider: ");

  return `${profile.name}  ${provider}\n  Sources: ${sources}${providerSource}`;
}

function formatProfile(profile: ReturnType<typeof describeProfile>): string {
  const settings = Bun.YAML.stringify({
    name: profile.name,
    provider: profile.provider,
    settings: profile.profile,
  }).trimEnd();
  const sources =
    Object.entries(profile.provenance)
      .map(([key, source]) => `  ${key}: ${source.type === "file" ? source.path : "default"}`)
      .join("\n") || "  no recorded fields";
  const providerSource = formatProviderSource(
    profile.providerSource,
    "\n  sandbox.default_provider: ",
  );

  return `${settings}\nSources:\n${sources}${providerSource}`;
}

function formatProviderSource(
  source: ReturnType<typeof describeProfile>["providerSource"],
  prefix: string,
): string {
  if (source?.type !== "file") return "";
  return `${prefix}${source.path}`;
}
