import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Visual-QA only (apps/companion/qa): the OBS overlay renderer at the address
// the editor preview requests (127.0.0.1:3666/overlay).
const root = fileURLToPath(new URL("./overlay", import.meta.url));
export default defineConfig({
  root,
  base: "/overlay/",
  cacheDir: fileURLToPath(new URL("./node_modules/.vite-qa-overlay", import.meta.url)),
  plugins: [react(), {
    // The editor requests "/overlay?…" (no trailing slash), as the worker serves it.
    name: "qa-overlay-entry",
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        if (req.url === "/overlay" || req.url?.startsWith("/overlay?")) req.url = `/overlay/${req.url.slice("/overlay".length)}`;
        next();
      });
    },
  }],
  server: { host: "127.0.0.1", port: 3666, strictPort: true, cors: true, hmr: false, fs: { allow: [fileURLToPath(new URL("../../..", import.meta.url))] } },
});
