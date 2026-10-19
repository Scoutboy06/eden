import { runCli } from "../../../src/modules/cli";

import completion from "./commands/completion";
import worktree from "./commands/worktree";
import mkdir from "./commands/mkdir";
import config from "./commands/config";
import sbx from "./commands/sbx";

await runCli({
  config,
  sbx,
  worktree,
  completion,
  mkdir,
});
