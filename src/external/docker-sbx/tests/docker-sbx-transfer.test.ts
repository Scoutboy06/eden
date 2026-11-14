import { expect, test } from "bun:test";
import { join } from "node:path";
import { installExecutable, pathWith } from "../../../modules/fs/tests/support/executable";
import { withTemporaryDirectory } from "../../../modules/fs/tests/support/temporary-directory";
import { DockerSandboxProvider } from "../provider";
import { dockerTransferArguments, transferDockerFiles } from "../transfer";

const binary = Buffer.from([0x0d, 0x0a, 0x00, 0xff, 0x1a, 0x0a, 0x0d, 0x80]);

test("transfer arguments keep stdin open only when a file is piped in", () => {
  expect(dockerTransferArguments({ name: "box", argv: ["tar", "x"] })).toEqual([
    "sbx",
    "exec",
    "--",
    "box",
    "tar",
    "x",
  ]);
  expect(dockerTransferArguments({ name: "box", argv: ["tar"], stdinFile: "in.tgz" })).toEqual([
    "sbx",
    "exec",
    "-i",
    "--",
    "box",
    "tar",
  ]);
});

test("provider transfer delegates to the injected transfer", async () => {
  const input = { name: "box", argv: ["true"], stdoutFile: "out" };
  const calls: unknown[] = [];
  const provider = new DockerSandboxProvider(undefined, {
    transfer: async (received) => {
      calls.push(received);
      return { exitCode: 0, stderr: "" };
    },
  });

  expect(await provider.transfer(input)).toEqual({ exitCode: 0, stderr: "" });
  expect(calls).toEqual([input]);
});

test("transfer streams bytes unchanged through files in both directions", async () => {
  await withTemporaryDirectory(async (directory) => {
    const argsFile = join(directory, "args.json");
    await installExecutable(
      new URL("./fixtures/sbx-transfer.ts", import.meta.url),
      directory,
      "sbx",
    );

    await withEnvironment(
      { PATH: pathWith(directory), EDEN_SBX_TRANSFER_ARGS: argsFile },
      async () => {
        const download = join(directory, "download.bin");
        const downloaded = await transferDockerFiles({
          name: "box",
          argv: ["sh", "-c", "tar -czf - -- a b", "sh", "a b"],
          stdoutFile: download,
        });

        expect(Buffer.from(await Bun.file(download).arrayBuffer())).toEqual(
          Buffer.from([0x0d, 0x0a, 0x00, 0xff, 0x1a]),
        );
        expect(downloaded).toEqual({ exitCode: 0, stderr: "transfer warning" });
        expect(JSON.parse(await Bun.file(argsFile).text())).toEqual([
          "exec",
          "--",
          "box",
          "sh",
          "-c",
          "tar -czf - -- a b",
          "sh",
          "a b",
        ]);

        const upload = join(directory, "upload.bin");
        const copy = join(directory, "copy.bin");
        await Bun.write(upload, binary);
        await transferDockerFiles({
          name: "box",
          argv: ["cat"],
          stdinFile: upload,
          stdoutFile: copy,
        });

        expect(Buffer.from(await Bun.file(copy).arrayBuffer())).toEqual(binary);
      },
    );
  });
});

async function withEnvironment(values: Record<string, string>, action: () => Promise<void>) {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);

  try {
    await action();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
