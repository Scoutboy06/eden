import { runCli } from "../../../src/modules/cli";

import mkdir from "./commands/mkdir";

await runCli({
  mkdir,
});
