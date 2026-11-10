import type { Execution } from "../execution";
import { FilesystemService } from "../fs";
import { createConfigService, type ConfigService } from "../config/config.service";
import { WorktreeService } from "../worktree/worktree.service";
import { HookService } from "../hook/hook.service";
import type { EdenExtensions } from "./options";
import { CommandOutput } from "./output";
import {
  createSandboxServiceFactory,
  type SandboxSelection,
  type SandboxService,
} from "../sandbox/sandbox.service";
import { findRepositoryPath } from "../config/repository";
import { checkSandboxFreshness } from "../sandbox/template-freshness";
import { TemplateUpdateService } from "../sandbox/template-update";
import { SetupService } from "../setup/setup.service";
import { PullRequestService } from "../pull-requests/service";

export function createCommandServices(options: EdenExtensions, execution: Execution) {
  const onStderr = options.json ? undefined : streamStderr;
  const hooks = new HookService(execution, { onStderr });
  const output = new CommandOutput(options, execution.operations);
  let fs: FilesystemService | undefined;
  let worktree: WorktreeService | undefined;
  let config: ConfigService | undefined;

  const readResolvedConfig = async () => {
    const repositoryPath = await findRepositoryPath(process.cwd());

    return createConfigService(undefined, { repositoryPath }).readWithProvenance();
  };

  const readConfig = async () => (await readResolvedConfig()).config;
  const createSandbox = createSandboxServiceFactory(
    execution,
    { read: readConfig },
    {
      onCreateOutput: options.json ? undefined : streamStdout,
      interactiveCreate:
        !options.json && !!process.stdin.isTTY && !!process.stdout.isTTY && !!process.stderr.isTTY,
      onHook: () => output.includeHooks(hooks.records),
      onWarning: options.json ? undefined : (warning) => streamStderr(`Warning: ${warning}\n`),
    },
    hooks,
  );

  return {
    output,
    get pullRequests() {
      return new PullRequestService(undefined, undefined, execution);
    },
    readResolvedConfig,
    readConfig,
    templateUpdate: new TemplateUpdateService(execution),
    checkSandboxFreshness,
    sandbox(selection?: SandboxSelection): Promise<SandboxService> {
      return createSandbox(selection);
    },
    get setup() {
      return new SetupService((config ??= createConfigService(execution)));
    },
    get config() {
      return (config ??= createConfigService(execution));
    },
    get worktree() {
      output.includeHooks(hooks.records);

      return (worktree ??= new WorktreeService(execution, { read: readConfig }, hooks));
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
