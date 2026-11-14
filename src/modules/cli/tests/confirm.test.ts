import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { confirm } from "../confirm";

async function answer(text: string | undefined) {
  const input = new PassThrough();
  const output = new PassThrough();
  const result = confirm("Remove? ", input, output);
  if (text === undefined) input.end();
  else input.end(text);

  return result;
}

test.each([
  ["y\n", true],
  ["YES\n", true],
  ["n\n", false],
  ["\n", false],
  ["maybe\n", false],
  [undefined, false],
])("confirmation answer %p resolves %p", async (text, expected) => {
  expect(await answer(text)).toBe(expected);
});
