import { styleText } from "node:util";

export function formatMessage(
  text: string,
  tone: "success" | "error",
  destination: "stdout" | "stderr",
): string {
  if (
    !process[destination].isTTY ||
    process.env.NO_COLOR !== undefined ||
    process.env.TERM === "dumb"
  ) {
    return text;
  }

  return text
    .split("\n")
    .map((line, index) => {
      if (index === 0) return styleText(tone === "success" ? "green" : "red", line);
      if (line.startsWith("  ")) return styleText("cyan", line);

      return line;
    })
    .join("\n");
}
