import { createExecution } from "../../../execution";
import { createFileConfigService } from "../../config.service";

export function createConfigHarness(path: string, dryRun = false) {
  const execution = createExecution({ dryRun });
  const config = createFileConfigService({ pathsLowToHigh: [path], execution });
  return { config, execution };
}
