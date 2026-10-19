export type ReadinessResult = {
  state: "ready" | "missing" | "unknown" | "timeout" | "skipped";
  label: string;
  instructions?: readonly string[];
};

export interface ReadinessCheck {
  readonly id: string;
  readonly checkingLabel: string;
  readonly skippedLabel: string;
  readonly dependencies: readonly string[];
  readonly instructions?: readonly string[];
  run(signal: AbortSignal): Promise<ReadinessResult>;
}
