import { defineCommand } from "../../../../src/modules/cli";
import { describeProfile, listProfiles } from "../../../../src/modules/sandbox/profiles";

const list = defineCommand({
  name: "list",
  description: "List effective sandbox profiles and their configuration sources",
  async run(_ctx, { readResolvedConfig, output }) {
    const profiles = listProfiles(await readResolvedConfig());

    output.write({
      data: { profiles },
      human: () =>
        profiles.length === 0
          ? "No sandbox profiles configured."
          : profiles
              .map(
                (profile) =>
                  `${profile.name}  ${profile.provider ?? "(no provider)"}\n  Sources: ${profile.sources.join(", ") || "no recorded fields"}${profile.providerSource?.type === "file" ? `\n  Default provider: ${profile.providerSource.path}` : ""}`,
              )
              .join("\n"),
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
      human: () =>
        `${Bun.YAML.stringify({ name: profile.name, provider: profile.provider, settings: profile.profile }).trimEnd()}\nSources:\n${
          Object.entries(profile.provenance)
            .map(([key, source]) => `  ${key}: ${source.type === "file" ? source.path : "default"}`)
            .join("\n") || "  no recorded fields"
        }${profile.providerSource?.type === "file" ? `\n  sandbox.default_provider: ${profile.providerSource.path}` : ""}`,
    });
  },
});

export default defineCommand({
  name: "profile",
  description: "Inspect sandbox profiles",
  subCommands: { list, show },
});
