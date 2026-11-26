import { resolve } from "node:path";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { listRegisteredProjects } from "../../src/modules/projects/project-registry";
import { createOpenCodeConversationClient } from "../../src/external/opencode/client";

import { createTasksMiddleware } from "./server/tasks";
import { createBunTerminalRuntime } from "./server/bun-terminal-runtime";
import { createHcTerminalRuntime } from "./server/hc-terminal-runtime";
import { createTerminalServer, isAllowedTerminalHost } from "./server/terminals";
import { createConversationMiddleware } from "./server/conversations";

const checkout = resolve(import.meta.dirname, "../..");
const webHost = process.env.EDEN_WEB_HOST ?? "127.0.0.1";
const terminalBackend = process.env.EDEN_TERMINAL_BACKEND ?? "hc";
const conversationE2E = process.env.EDEN_CONVERSATION_E2E === "1";
const fakeOpenCodeUrl = process.env.EDEN_OPENCODE_E2E_FAKE_URL;

if (!isAllowedTerminalHost(webHost))
  throw new Error("EDEN_WEB_HOST must be localhost or a Tailscale IP address.");
if (terminalBackend !== "hc" && terminalBackend !== "bun")
  throw new Error("EDEN_TERMINAL_BACKEND must be hc or bun.");
if (fakeOpenCodeUrl && !conversationE2E)
  throw new Error("EDEN_OPENCODE_E2E_FAKE_URL requires EDEN_CONVERSATION_E2E=1.");
if (conversationE2E && !isLoopbackHttpUrl(fakeOpenCodeUrl))
  throw new Error("Conversation E2E mode requires a fake OpenCode HTTP URL on loopback.");

const fakeOpenCodeEndpoint = conversationE2E ? { url: fakeOpenCodeUrl! } : undefined;
const fakeOpenCodeClient = fakeOpenCodeEndpoint
  ? createOpenCodeConversationClient({
      discover: async () => fakeOpenCodeEndpoint,
      wake: async () => {
        throw new Error("Conversation E2E mode never starts an OpenCode service.");
      },
    })
  : undefined;

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    {
      name: "eden-tasks",
      configureServer(server) {
        const conversations = createConversationApiMiddleware();
        if (server.httpServer)
          attachTerminalServer(
            server.httpServer as unknown as import("node:http").Server,
            conversations,
          );
        return () => {
          server.middlewares.use(createTasksMiddleware(checkout));
          server.middlewares.use(conversations);
        };
      },
      configurePreviewServer(server) {
        const conversations = createConversationApiMiddleware();
        attachTerminalServer(
          server.httpServer as unknown as import("node:http").Server,
          conversations,
        );
        return () => {
          server.middlewares.use(createTasksMiddleware(checkout));
          server.middlewares.use(conversations);
        };
      },
    },
  ],
  resolve: {
    alias: {
      "@": resolve(import.meta.dirname, "app"),
    },
  },
  server: {
    host: webHost,
    allowedHosts:
      webHost === "127.0.0.1" || webHost === "localhost" || webHost === "::1" ? [] : [webHost],
    port: conversationE2E ? 0 : 5173,
    strictPort: conversationE2E,
  },
  preview: { host: webHost, port: 4173 },
});

function isLoopbackHttpUrl(value: string | undefined): value is string {
  if (!value) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      ["127.0.0.1", "::1"].includes(url.hostname) &&
      !!url.port &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

function createConversationApiMiddleware() {
  return createConversationMiddleware({
    readProjects: async () =>
      Object.fromEntries(
        (await listRegisteredProjects()).map(({ key, name, path }) => [key, { name, path }]),
      ),
    ...(fakeOpenCodeClient ? { client: fakeOpenCodeClient } : {}),
  });
}

function attachTerminalServer(
  httpServer: import("node:http").Server,
  conversations: ReturnType<typeof createConversationApiMiddleware>,
) {
  const terminals = createTerminalServer({
    runtime: terminalBackend === "hc" ? createHcTerminalRuntime() : createBunTerminalRuntime(),
    readProjects: async () =>
      Object.fromEntries(
        (await listRegisteredProjects()).map(({ key, name, path }) => [key, { name, path }]),
      ),
  });
  httpServer.on("upgrade", (request, socket, head) => {
    if (request.url?.startsWith("/api/terminals/socket")) {
      if (!terminals.upgrade(request, socket, head)) socket.destroy();
      return;
    }
    if (request.url?.startsWith("/api/conversations/socket")) {
      if (!conversations.upgrade(request, socket, head)) socket.destroy();
    }
  });
  httpServer.on("close", () => {
    terminals.close();
    conversations.close();
  });
}
