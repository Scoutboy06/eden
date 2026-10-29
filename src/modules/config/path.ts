export function parseConfigPath(path: string): string[] {
  const keys: string[] = [];
  let offset = 0;
  const tokens = path.matchAll(/(?:^|\.)([^.[\]"\\\s]+)|\[("(?:[^"\\]|\\.)*")\]/gu);

  for (const token of tokens) {
    if (token.index !== offset || (offset === 0 && token[0].startsWith("."))) {
      throw invalidPath(path);
    }

    keys.push(token[1] ?? parseLiteralKey(token[2]!, path));
    offset += token[0].length;
  }

  if (offset !== path.length || keys.length === 0 || keys.some((key) => key.length === 0)) {
    throw invalidPath(path);
  }

  return keys;
}

export function formatConfigPath(keys: readonly string[]): string {
  return keys
    .map((key, index) =>
      /^[^.[\]"\\\s]+$/u.test(key) ? `${index === 0 ? "" : "."}${key}` : `[${JSON.stringify(key)}]`,
    )
    .join("");
}

function parseLiteralKey(literal: string, path: string): string {
  try {
    return JSON.parse(literal);
  } catch {
    throw invalidPath(path);
  }
}

function invalidPath(path: string): Error {
  return Object.assign(new Error(`Unknown configuration key: ${path}`), {
    code: "CONFIG_KEY_UNKNOWN",
  });
}
