import { runCli } from "../../../src/modules/cli";

import completion from "./commands/completion";
import mkdir from "./commands/mkdir";

await runCli({
  completion,
  mkdir,
});
