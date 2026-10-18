import { runCli } from "../../../src/modules/cli";

import completion from "./commands/completion";
import worktree from "./commands/worktree";
import mkdir from "./commands/mkdir";
import config from "./commands/config";

await runCli({
  config,
  worktree,
  completion,
  mkdir,
});
