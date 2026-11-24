import { resolve } from "node:path";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { listRegisteredProjects } from "../../src/modules/projects/project-registry";

import { createTasksMiddleware } from "./server/tasks";
import { createTerminalServer, isAllowedTerminalHost } from "./server/terminals";

const checkout = resolve(import.meta.dirname, "../..");
const webHost = process.env.EDEN_WEB_HOST ?? "127.0.0.1";

if (!isAllowedTerminalHost(webHost))
  throw new Error("EDEN_WEB_HOST must be localhost or a Tailscale IP address.");

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    {
      name: "eden-tasks",
      configureServer(server) {
        if (server.httpServer)
          attachTerminalServer(server.httpServer as unknown as import("node:http").Server);
        return () => server.middlewares.use(createTasksMiddleware(checkout));
      },
      configurePreviewServer(server) {
        attachTerminalServer(server.httpServer as unknown as import("node:http").Server);
        return () => server.middlewares.use(createTasksMiddleware(checkout));
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
    port: 5173,
  },
  preview: { host: webHost, port: 4173 },
});

function attachTerminalServer(httpServer: import("node:http").Server) {
  const terminals = createTerminalServer({
    readProjects: async () =>
      Object.fromEntries(
        (await listRegisteredProjects()).map(({ key, name, path }) => [key, { name, path }]),
      ),
  });
  httpServer.on("upgrade", (request, socket, head) => {
    if (
      request.url?.startsWith("/api/terminals/socket") &&
      !terminals.upgrade(request, socket, head)
    )
      socket.destroy();
  });
  httpServer.on("close", () => terminals.close());
}
