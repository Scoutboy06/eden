import type { Execution } from "../execution";
import { FilesystemService } from "../fs";
import { createConfigService, type ConfigService } from "../config/config.service";
import { WorktreeService } from "../worktree/worktree.service";
import { HookService } from "../hook/hook.service";
import type { EdenExtensions } from "./options";
import { CommandOutput } from "./output";
import { createSandboxService, type SandboxService } from "../sandbox/sandbox.service";
import type { SandboxProviderName } from "../sandbox/provider";
import { findRepositoryPath } from "../config/repository";
import { SetupService } from "../setup/setup.service";

export function createCommandServices(options: EdenExtensions, execution: Execution) {
  const onStderr = options.json ? undefined : streamStderr;
  const hooks = new HookService(execution, { onStderr });
  const output = new CommandOutput(options, execution.operations);
  let fs: FilesystemService | undefined;
  let worktree: WorktreeService | undefined;
  let config: ConfigService | undefined;

  const readConfig = async () => {
    const repositoryPath = await findRepositoryPath(process.cwd());

    return createConfigService(undefined, { repositoryPath }).read();
  };

  return {
    output,
    readConfig,
    async sandbox(providerName?: SandboxProviderName): Promise<SandboxService> {
      return createSandboxService(
        execution,
        providerName,
        { read: readConfig },
        options.json ? undefined : streamStdout,
      );
    },
    get setup() {
      return new SetupService((config ??= createConfigService(execution)));
    },
    get config() {
      return (config ??= createConfigService(execution));
    },
    get worktree() {
      output.includeHooks(hooks.records);

      return (worktree ??= new WorktreeService(
        execution,
        (config ??= createConfigService(execution)),
        hooks,
      ));
    },
    get fs() {
      return (fs ??= new FilesystemService(execution));
    },
  };
}

function streamStderr(text: string): void {
  process.stderr.write(text);
}

function streamStdout(text: string): void {
  process.stdout.write(text);
}

export type CommandServices = ReturnType<typeof createCommandServices>;
