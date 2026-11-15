import { defineCommand } from "../../../../src/modules/cli";
import {
  getRegisteredProject,
  listRegisteredProjects,
} from "../../../../src/modules/projects/project-registry";

const list = defineCommand({
  name: "list",
  description: "List registered local projects",
  async run(ctx, { output }) {
    const projects = await listRegisteredProjects({ dryRun: ctx.extensions.eden.dryRun });
    output.write({
      data: { projects },
      human: () => projects.map(({ key, name, path }) => `${key}\t${name}\t${path}`).join("\n"),
    });
  },
});

const init = defineCommand({
  name: "init",
  description: "Create project-local Eden configuration",
  args: {
    path: {
      type: "positional",
      required: false,
      description: "Path to an existing Git repository (defaults to the current repository)",
    },
  },
  async run(ctx, { output, projectScaffold }) {
    const project = await projectScaffold.init(ctx.values.path, { cwd: process.cwd() });
    output.write({
      data: { project },
      human: () => `Initialized project config at ${project.configPath}`,
    });
  },
});

const add = defineCommand({
  name: "add",
  description: "Register an existing local Git repository",
  args: {
    path: {
      type: "positional",
      description: "Path to an existing Git repository",
      required: true,
    },
    name: {
      type: "string",
      description: "Display name (defaults to the repository folder name)",
    },
  },
  async run(ctx, { output, projectRegistration }) {
    const project = await projectRegistration.add(
      { path: ctx.values.path, name: ctx.values.name },
      { cwd: process.cwd() },
    );
    output.write({
      data: { project },
      human: () => `${project.key}\t${project.name}\t${project.path}`,
    });
  },
});

const show = defineCommand({
  name: "show",
  description: "Show one registered local project by key",
  args: {
    key: {
      type: "positional",
      description: "Stable project key",
      required: true,
    },
  },
  async run(ctx, { output }) {
    const project = await getRegisteredProject(ctx.values.key, {
      dryRun: ctx.extensions.eden.dryRun,
    });
    output.write({
      data: { project },
      human: () => `${project.name} (${project.key})\n  ${project.path}`,
    });
  },
});

const remove = defineCommand({
  name: "remove",
  description: "Remove a registered local project",
  args: {
    key: {
      type: "positional",
      description: "Stable project key",
      required: true,
    },
  },
  async run(ctx, { output, projectRegistration }) {
    const project = await projectRegistration.remove(ctx.values.key);
    output.write({
      data: { project },
      human: () => `Removed project ${project.key}`,
    });
  },
});

export default defineCommand({
  name: "project",
  description: "Manage registered local projects",
  subCommands: { add, init, list, remove, show },
});
