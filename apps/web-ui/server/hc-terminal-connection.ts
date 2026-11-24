import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

const headerBytes = 9;
const maxFrameBytes = 16 * 1024 * 1024;
const requestTimeoutMs = 5000;

export const hcFrame = { data: 0, credit: 1, close: 2, resize: 3 } as const;

type Frame = { channel: number; kind: number; data: Buffer };

export async function connectHc(executable: string, session: string) {
  const child = spawn(executable, ["connect", "--session", session]);
  const connection = new HcConnection(child);
  try {
    child.stdin.write('{"jsonrpc":"2.0","id":0,"method":"hello","params":{"framed":true}}\n');
    const reply = await connection.withDeadline(() => connection.readHello());
    if (!reply.framed) throw new Error("herdr-core did not negotiate framed mode.");
    return connection;
  } catch (error) {
    connection.close();
    throw error;
  }
}

class HcConnection {
  private readonly chunks: AsyncIterator<Buffer>;
  private buffered: Buffer = Buffer.alloc(0);
  private failure?: Error;
  private stderr = "";

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    this.chunks = child.stdout[Symbol.asyncIterator]();
    child.on("error", (error) => {
      this.failure = error;
    });
    child.stdin.on("error", (error) => {
      this.failure = error;
    });
    child.stderr.on("data", (data: Buffer) => {
      this.stderr = (this.stderr + data.toString()).slice(-2048);
    });
  }

  async readHello() {
    let newline = this.buffered.indexOf(10);
    while (newline < 0) {
      await this.fill();
      newline = this.buffered.indexOf(10);
    }
    const reply = JSON.parse(this.take(newline + 1).toString());
    return reply.result ?? {};
  }

  async request<T>(method: string, params: object): Promise<T> {
    this.send(
      0,
      hcFrame.data,
      Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })),
    );
    const frame = await this.withDeadline(() => this.read());
    if (frame.channel !== 0 || frame.kind !== hcFrame.data)
      throw new Error("Expected a herdr-core RPC reply.");
    const reply = JSON.parse(frame.data.toString());
    if (reply.error) throw new Error(`herdr-core: ${reply.error.message}`);
    return reply.result as T;
  }

  send(channel: number, kind: number, data: Uint8Array) {
    const header = Buffer.alloc(headerBytes);
    header.writeUInt32LE(channel);
    header[4] = kind;
    header.writeUInt32LE(data.byteLength, 5);
    this.child.stdin.write(Buffer.concat([header, data]));
  }

  async read(): Promise<Frame> {
    while (this.buffered.length < headerBytes) await this.fill();
    const header = this.take(headerBytes);
    const length = header.readUInt32LE(5);
    if (length > maxFrameBytes) throw new Error("Invalid herdr-core frame length.");
    while (this.buffered.length < length) await this.fill();
    return { channel: header.readUInt32LE(), kind: header[4]!, data: this.take(length) };
  }

  close() {
    this.child.kill();
    this.child.stdin.destroy();
    this.child.stdout.destroy();
  }

  async withDeadline<T>(operation: () => Promise<T>): Promise<T> {
    const timer = setTimeout(() => this.close(), requestTimeoutMs);
    try {
      return await operation();
    } finally {
      clearTimeout(timer);
    }
  }

  private async fill() {
    const chunk = await this.chunks.next();
    if (chunk.done)
      throw this.failure ?? new Error(this.stderr.trim() || "herdr-core disconnected.");
    this.buffered = Buffer.concat([this.buffered, chunk.value]);
  }

  private take(length: number) {
    const bytes = this.buffered.subarray(0, length);
    this.buffered = this.buffered.subarray(length);
    return bytes;
  }
}
