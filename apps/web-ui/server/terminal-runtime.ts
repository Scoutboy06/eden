import type { AgentHarness } from "../shared/agent-harnesses";

export type TerminalIdentity = {
  id: string;
  project: string;
  worktree: string;
  branch: string | null;
  cwd: string;
  harness?: AgentHarness;
};

export type RuntimeTerminal = TerminalIdentity & {
  handle: string;
  cols: number;
  rows: number;
};

export type TerminalAttachment = {
  write(data: Uint8Array): void;
  resize(cols: number, rows: number): void;
  detach(): void;
  closed: Promise<{ code: number | null; exited: boolean }>;
};

export interface TerminalRuntime {
  readonly capabilities: {
    readonly recoverSessions: boolean;
    readonly savedScreens: boolean;
  };
  start(
    terminal: TerminalIdentity & { cols: number; rows: number },
    executable: string,
  ): Promise<RuntimeTerminal>;
  discover(): Promise<RuntimeTerminal[]>;
  attach(
    terminal: RuntimeTerminal,
    onData: (data: Uint8Array) => void,
  ): Promise<TerminalAttachment>;
  stop(terminal: RuntimeTerminal): Promise<void>;
}
