import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Visual-QA only (apps/companion/qa): the plugin UI served at the URL the
// Companion plugin iframe requests, reachable from its opaque-origin sandbox.
const root = fileURLToPath(new URL(".", import.meta.url));
export default defineConfig({
  root,
  base: "/plugin-ui/dota/0.2.7/",
  plugins: [react()],
  server: { port: 1431, strictPort: true, cors: true, hmr: false, fs: { allow: [fileURLToPath(new URL("../../..", import.meta.url))] } },
});
