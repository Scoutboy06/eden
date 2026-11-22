import { defineCommand } from "../../../../src/modules/cli";
import {
  checkAuthentication,
  exchangeOAuthSecret,
  TailscaleApiError,
} from "../../../../src/external/tailscale/api";
import * as credentials from "../../../../src/modules/tailnet/credentials";
import { createTailnetDeviceStore } from "../../../../src/modules/tailnet/devices";

const login = defineCommand({
  name: "login",
  description: "Store a Tailscale OAuth client secret",
  args: {},
  async run(ctx, { output }) {
    if (process.stdin.isTTY)
      throw new Error(
        "Provide the OAuth client secret through stdin (for example, a password manager pipe).",
      );
    const secret = (await Bun.stdin.text()).trim();
    if (!secret) throw new Error("No OAuth client secret was provided on stdin.");
    const token = await exchangeOAuthSecret(secret);
    const authentication = await checkAuthentication(token);
    if (authentication !== "authenticated")
      throw new Error("Tailscale did not authenticate the provided client secret.");
    await credentials.set(secret);
    output.write({
      data: { host: "eden" },
      human: () => "Authenticated and stored Eden Tailscale credentials.",
    });
  },
});

const logout = defineCommand({
  name: "logout",
  description: "Delete stored Tailscale credentials",
  args: {},
  async run(ctx, { output }) {
    await credentials.remove();
    output.write({
      data: { host: "eden" },
      human: () => "Deleted local Eden Tailscale credentials.",
    });
  },
});

const status = defineCommand({
  name: "status",
  description: "Report stored credentials and live Tailscale authentication",
  args: {},
  async run(ctx, { output }) {
    const secret = await credentials.get();
    const live = secret
      ? await exchangeOAuthSecret(secret)
          .then(checkAuthentication)
          .catch((error: unknown) =>
            error instanceof TailscaleApiError && (error.status === 401 || error.status === 403)
              ? "rejected"
              : "unreachable",
          )
      : undefined;
    const api =
      live === undefined
        ? "Not checked"
        : live === "authenticated"
          ? "Authenticated"
          : live === "rejected"
            ? "Credentials rejected"
            : "Unreachable";
    const devices = await createTailnetDeviceStore().list();
    const recovery = [
      ...(!secret || live === "rejected" ? ["    eden tailscale login"] : []),
      ...(live === "unreachable" ? ["    eden tailscale status"] : []),
    ];
    output.write({
      data: {
        host: "eden",
        credentials: secret ? "Stored" : "Missing",
        api,
        devices,
        pendingCleanup: devices.filter((device) => device.pendingCleanup),
      },
      human: () =>
        `Tailscale Eden\n  Credential storage: ${secret ? "Stored" : "Missing"}\n  Live API authentication: ${api}\n  Recorded sandbox devices: ${devices.length}${devices.length ? `\n${devices.map((device) => `    ${device.sandboxName}: ${device.dnsName}${device.pendingCleanup ? " (pending cleanup)" : ""}`).join("\n")}` : ""}${recovery.length ? `\n  Recovery:\n${recovery.join("\n")}` : ""}`,
    });
  },
});

export default defineCommand({
  name: "tailscale",
  description: "Manage Tailscale credentials and authentication",
  subCommands: { login, logout, status },
});
