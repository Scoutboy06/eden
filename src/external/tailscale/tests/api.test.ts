import { expect, test } from "bun:test";
import { createAuthKey, deleteDevice, exchangeOAuthSecret, revokeAuthKey } from "../api";

test("exchanges the client secret, mints a one-use tagged key, then revokes it", async () => {
  const requests: Array<{
    path: string;
    method: string;
    body: string;
    authorization: string | null;
  }> = [];
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      requests.push({
        path: url.pathname,
        method: request.method,
        body: request.method === "GET" ? "" : "",
        authorization: request.headers.get("authorization"),
      });

      if (url.pathname.endsWith("/oauth/token")) return Response.json({ access_token: "token" });
      if (url.pathname.endsWith("/keys") && request.method === "POST")
        return Response.json({ id: "key-id", key: "tskey-auth-once" });

      return new Response(null, { status: 204 });
    },
  });

  try {
    const dependencies = { baseUrl: `http://localhost:${server.port}` };
    const token = await exchangeOAuthSecret("client-secret", dependencies);
    const key = await createAuthKey(token, "tag:eden-sbx", dependencies);
    await revokeAuthKey(token, key.id, dependencies);

    expect(token).toBe("token");
    expect(key).toEqual({ id: "key-id", key: "tskey-auth-once" });
    expect(requests.map(({ path, method }) => [path, method])).toEqual([
      ["/api/v2/oauth/token", "POST"],
      ["/api/v2/tailnet/-/keys", "POST"],
      ["/api/v2/tailnet/-/keys/key-id", "DELETE"],
    ]);
    expect(requests[1]?.authorization).toBe("Bearer token");
  } finally {
    server.stop();
  }
});

test("deletes a device idempotently when Tailscale returns 404", async () => {
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      expect(new URL(request.url).pathname).toBe("/api/v2/device/node-id");
      expect(request.method).toBe("DELETE");

      return new Response(null, { status: 404 });
    },
  });

  try {
    await expect(
      deleteDevice("token", "node-id", { baseUrl: `http://localhost:${server.port}` }),
    ).resolves.toBeUndefined();
  } finally {
    server.stop();
  }
});

test("does not include credentials in API errors", async () => {
  const server = Bun.serve({ port: 0, fetch: () => new Response("secret echo", { status: 401 }) });

  try {
    await expect(
      exchangeOAuthSecret("client-secret", { baseUrl: `http://localhost:${server.port}` }),
    ).rejects.toThrow("rejected the OAuth client secret (401)");
  } finally {
    server.stop();
  }
});
