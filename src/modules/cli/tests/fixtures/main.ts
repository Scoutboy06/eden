import { runCli } from "../../parser";
import { defineCommand } from "../../command";
import {
  codedFailure,
  echo,
  emptyAggregate,
  loadingFailure,
  singleAggregate,
  twoRequiredOptions,
  uncodedFailure,
} from "./commands";

await runCli({
  nested: defineCommand({ name: "nested", subCommands: { echo } }),
  echo,
  "two-required-options": twoRequiredOptions,
  "uncoded-failure": uncodedFailure,
  "coded-failure": codedFailure,
  "empty-aggregate": emptyAggregate,
  "single-aggregate": singleAggregate,
  "loading-failure": loadingFailure,
});
