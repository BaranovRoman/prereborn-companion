import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// WK-116 Phase 4 - Twitch Extensions are uploaded to the Developer Console
// as a static asset bundle Twitch itself hosts and serves (not something
// this repo deploys) - a single self-contained HTML file (same
// vite-plugin-singlefile approach Companion's overlay-renderer already
// uses, see apps/companion/vite.overlay-renderer.config.ts) is the simplest
// thing to package and upload, and keeps this "transparent interaction
// layer only" surface genuinely small - no separate JS/CSS asset requests
// for Twitch's CDN to serve.
export default defineConfig({
  plugins: [viteSingleFile()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    cssCodeSplit: false,
    assetsInlineLimit: 100_000_000,
  },
});
