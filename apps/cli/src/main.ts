#!/usr/bin/env bun
import { runCli } from "../../../src/modules/cli";

import completion from "./commands/completion";
import worktree from "./commands/worktree";
import mkdir from "./commands/mkdir";
import config from "./commands/config";
import profile from "./commands/profile";
import sbx from "./commands/sbx";
import setup from "./commands/setup";

await runCli({
  setup,
  config,
  profile,
  sbx,
  worktree,
  completion,
  mkdir,
});
