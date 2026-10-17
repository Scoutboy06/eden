export interface Operation {
  type: string;
  description: string;
  input: Record<string, unknown>;
}

export interface Execution {
  readonly dryRun: boolean;
  readonly operations: readonly Operation[];

  run<T>(action: () => Promise<T>): Promise<ExecutionResult<T>>;

  mutate(operation: Operation, action: () => Promise<void>): Promise<void>;
}

export type ExecutionResult<T> =
  | { ok: true; dryRun: boolean; data: T }
  | { ok: false; dryRun: boolean; error: unknown };
