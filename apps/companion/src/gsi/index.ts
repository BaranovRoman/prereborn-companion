// Thin re-export of the GSI-related surface consumed by the UI.
// The actual detection / config-writing / HTTP-listener logic lives in the
// Rust side (src-tauri/src/gsi, src-tauri/src/server) — nothing here does
// real work, it just names the domain for the frontend.
export { findDota, pickDotaFolder, installGsi } from "../services/dotaCompanionApi";
export type { StatusSnapshot, LastEvent } from "../types/status";
