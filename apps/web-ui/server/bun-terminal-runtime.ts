import type { RuntimeTerminal, TerminalAttachment, TerminalRuntime } from "./terminal-runtime";

export function createBunTerminalRuntime(spawn = Bun.spawn): TerminalRuntime {
  const terminals = new Map<
    string,
    {
      process: ReturnType<typeof Bun.spawn>;
      subscribe: (listener: (data: Uint8Array) => void) => void;
    }
  >();

  return {
    capabilities: { recoverSessions: false, savedScreens: false },
    async start(terminal, executable) {
      let receive: ((data: Uint8Array) => void) | undefined;
      const pending: Uint8Array[] = [];
      const process = spawn([executable], {
        cwd: terminal.cwd,
        env: { ...globalThis.process.env, TERM: "xterm-256color" },
        terminal: {
          cols: terminal.cols,
          rows: terminal.rows,
          name: "xterm-256color",
          data: (_pty, data) => {
            if (receive) receive(data);
            else pending.push(Uint8Array.from(data));
          },
        },
      });
      terminals.set(terminal.id, {
        process,
        subscribe(listener) {
          receive = listener;
          for (const chunk of pending.splice(0)) listener(chunk);
        },
      });
      return { ...terminal, handle: terminal.id };
    },
    async discover() {
      return [];
    },
    async attach(terminal, onData) {
      const entry = terminals.get(terminal.handle);
      if (!entry) throw new Error("Bun terminal not found.");
      entry.subscribe(onData);
      return bunAttachment(entry.process, () => terminals.delete(terminal.handle));
    },
    async stop(terminal: RuntimeTerminal) {
      terminals.get(terminal.handle)?.process.kill();
    },
  };
}

function bunAttachment(
  child: ReturnType<typeof Bun.spawn>,
  remove: () => void,
): TerminalAttachment {
  return {
    write: (data) => {
      child.terminal?.write(data);
    },
    resize: (cols, rows) => {
      child.terminal?.resize(cols, rows);
    },
    detach() {
      child.terminal?.close();
      remove();
    },
    closed: child.exited.then((code) => ({ code, exited: true })),
  };
}
