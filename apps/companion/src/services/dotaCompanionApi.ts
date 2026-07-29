import { invoke } from "@tauri-apps/api/core";
import type { DiagnosticsStatusSnapshot, StatusSnapshot } from "../types/status";

export const getStatus = () => invoke<StatusSnapshot>("get_status");
export const findDota = () => invoke<StatusSnapshot>("find_dota");
export const pickDotaFolder = () => invoke<StatusSnapshot>("pick_dota_folder");
export const installGsi = () => invoke<StatusSnapshot>("install_gsi");
export const openLogsFolder = () => invoke<void>("open_logs_folder");
export const openDotaFolder = () => invoke<void>("open_dota_folder");
export const clearLog = () => invoke<StatusSnapshot>("clear_log");
export const saveCompanionToken = (token: string) =>
  invoke<StatusSnapshot>("save_companion_token", { token });
export const resendCurrentState = () =>
  invoke<StatusSnapshot>("resend_current_state");

// Diagnostic-mode GSI capture - off by default, see src-tauri/src/diagnostics.
export const diagnosticsGetStatus = () =>
  invoke<DiagnosticsStatusSnapshot>("diagnostics_get_status");
export const diagnosticsStart = () =>
  invoke<DiagnosticsStatusSnapshot>("diagnostics_start");
export const diagnosticsStop = () =>
  invoke<DiagnosticsStatusSnapshot>("diagnostics_stop");
export const diagnosticsClear = () =>
  invoke<DiagnosticsStatusSnapshot>("diagnostics_clear");
export const diagnosticsExport = () => invoke<string>("diagnostics_export");
