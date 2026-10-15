import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";
const root=fileURLToPath(new URL("./overlay",import.meta.url));
export default defineConfig({
  root,plugins:[react(),viteSingleFile()],
  build:{outDir:"../dist/overlay",emptyOutDir:true,cssCodeSplit:false,assetsInlineLimit:100_000_000},
});
