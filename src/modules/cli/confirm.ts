import { createInterface } from "node:readline";

export function confirm(
  question: string,
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stderr,
): Promise<boolean> {
  return new Promise((resolve) => {
    const terminal = createInterface({ input, output });
    terminal.on("close", () => resolve(false));
    terminal.question(question, (answer) => {
      resolve(/^y(es)?$/i.test(answer.trim()));
      terminal.close();
    });
  });
}
