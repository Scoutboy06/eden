import { runCli } from "../../parser";
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
  echo,
  "two-required-options": twoRequiredOptions,
  "uncoded-failure": uncodedFailure,
  "coded-failure": codedFailure,
  "empty-aggregate": emptyAggregate,
  "single-aggregate": singleAggregate,
  "loading-failure": loadingFailure,
});
