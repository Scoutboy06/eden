import type { Execution } from "../execution";
import { GitModule } from "./git.module";

export class GitService {
  constructor(private readonly execution: Execution) {}

  async createBranch(
    input: { name: string; startPoint?: string },
    cwd = process.cwd(),
  ): Promise<void> {
    await GitModule.validateNewBranch(cwd, input.name, input.startPoint);
    await this.execution.mutate(
      { type: "git.branch.create", description: `Create local branch ${input.name}`, input },
      () => GitModule.createBranch(cwd, input.name, input.startPoint),
    );
  }

  async renameBranch(input: { name: string; newName: string }, cwd = process.cwd()): Promise<void> {
    await GitModule.validateRenameBranch(cwd, input.name, input.newName);
    await this.execution.mutate(
      {
        type: "git.branch.rename",
        description: `Rename local branch ${input.name} to ${input.newName}`,
        input,
      },
      () => GitModule.renameBranch(cwd, input.name, input.newName),
    );
  }

  async deleteBranch(input: { name: string; force?: boolean }, cwd = process.cwd()): Promise<void> {
    await GitModule.validateDeleteBranch(cwd, input.name, input.force);
    await this.execution.mutate(
      { type: "git.branch.delete", description: `Delete local branch ${input.name}`, input },
      () => GitModule.deleteBranch(cwd, input.name, input.force),
    );
  }

  async publishBranch(
    input: { name: string; remote: string; forceWithLease?: boolean },
    cwd = process.cwd(),
  ): Promise<void> {
    await GitModule.validatePublishBranch(cwd, input.name, input.remote);
    await this.execution.mutate(
      {
        type: "git.branch.publish",
        description: `Publish ${input.name} to ${input.remote}`,
        input,
      },
      () => GitModule.publishBranch(cwd, input.name, input.remote, input.forceWithLease),
    );
  }

  async fetch(input: { remote: string }, cwd = process.cwd()): Promise<void> {
    GitModule.validateRemote(input.remote);
    await this.execution.mutate(
      { type: "git.fetch", description: `Fetch from ${input.remote}`, input },
      () => GitModule.fetch(cwd, input.remote),
    );
  }
}
