import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// `pnpm qa:serve` - Companion shell on :1430, the Dota plugin UI dev server
// is proxied in at the path the plugin iframe requests.
const root = fileURLToPath(new URL(".", import.meta.url));
export default defineConfig({
  root,
  plugins: [react()],
  server: {
    port: 1430,
    strictPort: true,
    cors: true,
    fs: { allow: [fileURLToPath(new URL("../../..", import.meta.url))] },
    proxy: { "/plugin-ui/dota": { target: "http://localhost:1431", changeOrigin: true } },
  },
});
