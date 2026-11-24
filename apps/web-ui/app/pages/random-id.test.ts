import { expect, test } from "bun:test";

import { randomId } from "./random-id";

test("creates UUID-formatted random IDs without crypto.randomUUID", () => {
  const first = randomId();
  const second = randomId();

  expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(second).not.toBe(first);
});
