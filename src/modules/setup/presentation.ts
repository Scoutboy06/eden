import { styleText } from "node:util";
import type { ReadinessCheck } from "../sandbox/readiness";
import type { ReadinessState } from "./readiness";

export function formatReadiness(
  state: ReadinessState,
  checks: readonly ReadinessCheck[],
  frame: number,
): string {
  const { result, checking } = state;
  const check = checks.find((candidate) => candidate.id === state.id)!;

  if (checking && result.state === "skipped") {
    return styleText("gray", `${["◐", "◓", "◑", "◒"][frame % 4]} ${check.checkingLabel}`);
  }

  const appearances = {
    ready: { color: "green", marker: "✓" },
    missing: { color: "red", marker: "!" },
    skipped: { color: "gray", marker: "—" },
    unknown: { color: "yellow", marker: "?" },
    timeout: { color: "yellow", marker: "?" },
  } as const;
  const { color, marker } = appearances[result.state];

  return `${styleText(color, `${marker} ${result.label}`)}${styleText("gray", refreshIndicator(state, frame))}`;
}

function refreshIndicator(state: ReadinessState, frame: number): string {
  if (state.result.state === "ready" || state.result.state === "skipped") return "";
  if (state.checking) return ` ${["◐", "◓", "◑", "◒"][frame % 4]}`;
  if (state.retryIn !== undefined) return ` (${state.retryIn}s)`;

  return "";
}
