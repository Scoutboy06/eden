import { expect, test } from "bun:test";

import { TaskRequestError, taskRequest } from "./task-resource";

test("classifies rejected PATCH responses as definite and server failures as ambiguous", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    Response.json({ error: "Invalid changes." }, { status: 400 })) as unknown as typeof fetch;
  try {
    const definite = await taskRequest("eden", "eden-1", { method: "PATCH" }).catch(
      (error) => error,
    );
    expect(definite).toBeInstanceOf(TaskRequestError);
    expect(definite.ambiguous).toBe(false);

    globalThis.fetch = (async () =>
      Response.json({ error: "Unavailable." }, { status: 503 })) as unknown as typeof fetch;
    const ambiguous = await taskRequest("eden", "eden-1", { method: "PATCH" }).catch(
      (error) => error,
    );
    expect(ambiguous).toBeInstanceOf(TaskRequestError);
    expect(ambiguous.ambiguous).toBe(true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("classifies a lost transport response as ambiguous", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("connection reset");
  }) as unknown as typeof fetch;
  try {
    const result = await taskRequest("eden", "eden-1", { method: "PATCH" }).catch((error) => error);
    expect(result).toBeInstanceOf(TaskRequestError);
    expect(result.ambiguous).toBe(true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
