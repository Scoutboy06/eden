import { join } from "node:path";
import * as v from "valibot";
import {
  DockerSandboxProvider,
  type DockerCommandRunner,
} from "../../../../external/docker-sbx/provider";
import { ConfigSchema } from "../../../config/schema";
import { createExecution } from "../../../execution";
import { HookService } from "../../../hook/hook.service";
import { createSandboxService } from "../../sandbox.service";
import type { SandboxProviderName } from "../../provider";

export async function createSandboxHarness(options: {
  directory: string;
  config?: v.InferInput<typeof ConfigSchema>;
  provider?: SandboxProviderName;
  profile?: string;
  dryRun?: boolean;
  useDefaultProfile?: boolean;
  run?: DockerCommandRunner;
}) {
  const execution = createExecution({ dryRun: options.dryRun ?? false });
  const commands: { args: string[]; options: Parameters<DockerCommandRunner>[1] }[] = [];
  const warnings: string[] = [];
  const config = v.parse(
    ConfigSchema,
    options.config ?? { sandbox: { default_provider: "docker-sbx" } },
  );
  const provider = new DockerSandboxProvider(undefined, {
    run: async (args, runOptions) => {
      commands.push({ args: [...args], options: runOptions });
      return options.run
        ? options.run(args, runOptions)
        : { exitCode: 0, stdout: args[0] === "ls" ? "[]" : "", stderr: "" };
    },
  });
  const service = await createSandboxService(
    execution,
    options.provider,
    { read: async () => config },
    undefined,
    options.profile,
    {
      useDefaultProfile: options.useDefaultProfile,
      hooks: new HookService(execution, { directory: join(options.directory, "hooks") }),
      onWarning: (warning) => warnings.push(warning),
      providerFactory: () => provider,
    },
  );

  return { service, execution, provider, commands, warnings };
}
