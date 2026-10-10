import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL(".", import.meta.url));
export default { root, base: "./", build: { outDir: "dist", emptyOutDir: true,
  rollupOptions: { input: { main: `${root}/index.html`, overlay: `${root}/overlay/index.html` } } } };
