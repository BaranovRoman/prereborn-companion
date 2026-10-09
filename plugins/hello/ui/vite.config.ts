import { fileURLToPath } from "node:url";
export default {
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "./",
  build: { outDir: "dist", emptyOutDir: true },
};
