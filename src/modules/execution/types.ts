export interface Operation {
  type: string;
  description: string;
  input: Record<string, unknown>;
}

export interface Execution {
  readonly dryRun: boolean;
  readonly operations: readonly Operation[];

  mutate(operation: Operation, action: () => Promise<void>): Promise<void>;
}
