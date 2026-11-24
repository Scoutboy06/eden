import { isAbsolute } from "node:path";

import { isAgentHarness } from "../shared/agent-harnesses";
import { connectHc, hcFrame } from "./hc-terminal-connection";
import type { RuntimeTerminal, TerminalIdentity, TerminalRuntime } from "./terminal-runtime";

const owner = "eden-web";
const edenLabels = { eden_owner: owner };
type Connection = Awaited<ReturnType<typeof connectHc>>;

type HcTerminal = {
  address: string;
  state: string;
  cwd: string;
  cols: number;
  rows: number;
  labels?: Record<string, string>;
};

export function createHcTerminalRuntime({
  executable = Bun.which("hc") ?? Bun.which("herdr-core"),
  session = "eden-web",
}: { executable?: string | null; session?: string } = {}): TerminalRuntime {
  async function connect() {
    if (!executable)
      throw new Error("Install herdr-core (hc) on the Eden server PATH to use Doing terminals.");
    return connectHc(executable, session);
  }

  async function request<T>(method: string, params: object) {
    const connection = await connect();
    try {
      return await connection.request<T>(method, params);
    } finally {
      connection.close();
    }
  }

  return {
    capabilities: { recoverSessions: true, savedScreens: true },
    async start(terminal, executable) {
      const { address } = await request<{ address: string }>("terminal.run", {
        argv: [executable],
        cwd: terminal.cwd,
        labels: encodeLabels(terminal),
        size: { cols: terminal.cols, rows: terminal.rows },
        no_parent: true,
        wait: false,
      });
      return { ...terminal, handle: address };
    },
    async discover() {
      const { terminals } = await request<{ terminals: HcTerminal[] }>("terminal.list", {
        labels: edenLabels,
      });
      return terminals.flatMap((terminal) => {
        const recovered = decodeTerminal(terminal);
        return recovered ? [recovered] : [];
      });
    },
    async attach(terminal, onData) {
      const connection = await connect();
      try {
        const { channel } = await connection.request<{ channel: number }>("terminal.attach", {
          terminal: terminal.handle,
          cols: terminal.cols,
          rows: terminal.rows,
          history: 0,
        });
        await connection.withDeadline(async () => {
          const first = await connection.read();
          if (first.channel !== channel || first.kind !== hcFrame.data)
            throw new Error("herdr-core closed before sending the terminal screen.");
          writeOutput(connection, channel, first.data, onData);
        });
        return {
          write: (data) => connection.send(channel, hcFrame.data, data),
          resize(cols, rows) {
            const size = Buffer.alloc(4);
            size.writeUInt16LE(cols);
            size.writeUInt16LE(rows, 2);
            connection.send(channel, hcFrame.resize, size);
          },
          detach: () => connection.close(),
          closed: readOutput(connection, channel, onData),
        };
      } catch (error) {
        connection.close();
        throw error;
      }
    },
    async stop(terminal) {
      await request("terminal.kill", { terminal: terminal.handle });
    },
  };
}

function encodeLabels(terminal: TerminalIdentity) {
  return {
    ...edenLabels,
    eden_id: terminal.id,
    eden_project: terminal.project,
    eden_worktree: terminal.worktree,
    eden_branch: JSON.stringify(terminal.branch),
    eden_cwd: terminal.cwd,
    ...(terminal.harness ? { eden_harness: terminal.harness } : {}),
  };
}

function decodeTerminal(record: HcTerminal): RuntimeTerminal | undefined {
  const labels = record.labels;
  if (record.state !== "live" || labels?.eden_owner !== owner) return;
  const { eden_id: id, eden_project: project, eden_worktree: worktree, eden_cwd: cwd } = labels;
  if (!id || !project || !worktree || !cwd || !isAbsolute(cwd)) return;
  try {
    const branch: unknown = JSON.parse(labels.eden_branch ?? "");
    if (branch !== null && typeof branch !== "string") return;
    return {
      id,
      project,
      worktree,
      branch,
      cwd,
      handle: record.address,
      harness: isAgentHarness(labels.eden_harness) ? labels.eden_harness : undefined,
      cols: record.cols,
      rows: record.rows,
    };
  } catch {
    return;
  }
}

async function readOutput(
  connection: Connection,
  channel: number,
  onData: (data: Uint8Array) => void,
) {
  try {
    while (true) {
      const frame = await connection.read();
      if (frame.channel !== channel) continue;
      if (frame.kind === hcFrame.close) {
        const result = frame.data.length ? JSON.parse(frame.data.toString()) : null;
        return { code: result?.exit_code ?? null, exited: Boolean(result?.reason) };
      }
      if (frame.kind !== hcFrame.data) continue;
      writeOutput(connection, channel, frame.data, onData);
    }
  } catch {
    return { code: null, exited: false };
  } finally {
    connection.close();
  }
}

function writeOutput(
  connection: Connection,
  channel: number,
  bytes: Buffer,
  onData: (data: Uint8Array) => void,
) {
  onData(bytes);
  const credit = Buffer.alloc(4);
  credit.writeUInt32LE(bytes.length);
  connection.send(channel, hcFrame.credit, credit);
}
