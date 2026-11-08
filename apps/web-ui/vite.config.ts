import { resolve } from "node:path";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

import { createTasksMiddleware } from "./server/tasks";

const checkout = resolve(import.meta.dirname, "../..");

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    {
      name: "eden-tasks",
      configureServer(server) {
        return () => server.middlewares.use(createTasksMiddleware(checkout));
      },
      configurePreviewServer(server) {
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
    port: 5173,
  },
});
