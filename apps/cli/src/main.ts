import { runCli } from "../../../src/modules/cli";

import completion from "./commands/completion";
import worktree from "./commands/worktree";
import mkdir from "./commands/mkdir";

await runCli({
  worktree,
  completion,
  mkdir,
});
