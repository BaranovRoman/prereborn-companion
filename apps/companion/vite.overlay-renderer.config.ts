import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";

// WK-121 - builds overlay-renderer/ into ONE self-contained HTML file (JS/CSS
// inlined via vite-plugin-singlefile) so the Rust local overlay server
// (overlay_server.rs) can embed it with a plain `include_str!`, the same
// mechanism it already used for WK-120's dev-preview page - no new
// multi-asset static file router needed on the Rust side. Output is
// deliberately committed to the repo (see
// src-tauri/src/overlay_server/renderer.html) rather than gitignored: it's
// a compile-time dependency of overlay_server.rs (`include_str!` needs the
// file to exist even for a plain `cargo check`, not only inside a full
// `tauri build`), matching how the file it replaces was already a plain
// checked-in static file. Regenerate + commit it whenever overlay-renderer/
// source changes by running `pnpm build:overlay-renderer`.
export default defineConfig({
  root: "overlay-renderer",
  plugins: [react(), viteSingleFile()],
  build: {
    outDir: "../src-tauri/src/overlay_server/renderer-dist",
    emptyOutDir: true,
    cssCodeSplit: false,
    assetsInlineLimit: 100_000_000,
  },
});
