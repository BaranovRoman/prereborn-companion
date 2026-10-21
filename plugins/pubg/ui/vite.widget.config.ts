import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";
// OBS Browser Source renderer: one self-contained file served by the worker
// at http://127.0.0.1:3667/pubg/widget (package path ui/widget/index.html).
const root = fileURLToPath(new URL("./widget", import.meta.url));
export default defineConfig({
  root, plugins: [react(), viteSingleFile()],
  build: { outDir: "../dist/widget", emptyOutDir: true, cssCodeSplit: false, assetsInlineLimit: 100_000_000 },
});
