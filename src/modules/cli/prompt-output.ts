import { Writable } from "node:stream";

export function createPromptOutput() {
  const output = new Writable({
    write(chunk, _encoding, callback) {
      process.stdout.write(chunk, callback);
    },
  });
  Object.defineProperties(output, {
    columns: { get: () => process.stdout.columns },
    rows: { get: () => process.stdout.rows },
    isTTY: { get: () => process.stdout.isTTY },
  });
  const refresh = () => output.emit("resize");
  process.stdout.on("resize", refresh);

  return {
    output,
    refresh,
    close() {
      process.stdout.off("resize", refresh);
      output.end();
    },
  };
}
