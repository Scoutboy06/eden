import { defineCommand } from "../../../../src/modules/cli";

const add = defineCommand({
  name: "add",
  description: "Register a remote host endpoint",
  args: {
    alias: { type: "positional", required: true, description: "Local host alias" },
    url: { type: "string", required: true, description: "HTTP(S) host URL" },
  },
  async run(ctx, { config, output }) {
    await config.addHost(ctx.values.alias, ctx.values.url);
    output.write({
      data: { alias: ctx.values.alias, url: ctx.values.url },
      human: () => `Added host ${ctx.values.alias}`,
    });
  },
});

const list = defineCommand({
  name: "list",
  description: "List registered host endpoints",
  async run(_ctx, { config, output }) {
    const hosts = await config.readHosts();
    output.write({
      data: { hosts },
      human: () =>
        Object.entries(hosts)
          .map(([alias, host]) => `${alias}\t${host.url}`)
          .join("\n"),
    });
  },
});

const show = defineCommand({
  name: "show",
  description: "Show a registered host endpoint",
  args: { alias: { type: "positional", required: true, description: "Local host alias" } },
  async run(ctx, { config, output }) {
    const host = (await config.readHosts())[ctx.values.alias];
    if (!host) throw new Error("Host not found.");
    output.write({
      data: { alias: ctx.values.alias, ...host },
      human: () => `${ctx.values.alias}\t${host.url}`,
    });
  },
});

const update = defineCommand({
  name: "update",
  description: "Update a registered host endpoint or alias",
  args: {
    currentAlias: { type: "positional", required: true, description: "Current local host alias" },
    url: { type: "string", required: false, description: "New HTTP(S) host URL" },
    alias: { type: "string", required: false, description: "New local host alias" },
  },
  async run(ctx, { config, output }) {
    if (ctx.values.url === undefined && ctx.values.alias === undefined)
      throw new Error("Provide --url and/or --alias.");
    await config.updateHost(ctx.values.currentAlias, {
      url: ctx.values.url,
      newAlias: ctx.values.alias,
    });
    output.write({
      data: {
        alias: ctx.values.alias ?? ctx.values.currentAlias,
        ...(ctx.values.url ? { url: ctx.values.url } : {}),
      },
      human: () => "Updated host",
    });
  },
});

const remove = defineCommand({
  name: "remove",
  description: "Remove a host from local configuration",
  args: { alias: { type: "positional", required: true, description: "Local host alias" } },
  async run(ctx, { config, output }) {
    await config.removeHost(ctx.values.alias);
    output.write({
      data: { alias: ctx.values.alias },
      human: () => `Removed host ${ctx.values.alias}`,
    });
  },
});

export default defineCommand({
  name: "host",
  description: "Manage remote host endpoint configuration",
  subCommands: { add, list, show, update, remove },
});
