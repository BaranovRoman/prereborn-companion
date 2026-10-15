import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
const root = fileURLToPath(new URL(".", import.meta.url));
export default { root, base: "./", plugins: [react()], build: { outDir: "dist", emptyOutDir: true,
  rollupOptions: { input: { main: `${root}/index.html`, overlay: `${root}/overlay/index.html` } } } };
