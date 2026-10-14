import { invoke } from "@tauri-apps/api/core";
export interface Manifest {
  id: string; name: string; description: string; version: string; platform: string; arch: string;
  minApi: number; maxApi: number; ui: string; permissions: string[];
}
export interface Release { manifest: Manifest; url: string; sha256: string; signature: string }
export interface Runtime { phase: "running" | "starting" | "stopped" | "failed"; lastError: string | null; state: unknown }
export interface Installed {
  id: string; manifest: Manifest | null; error: string | null; runtime: Runtime | null;
  installed: { active: string; previous: string | null; pending: string | null; enabled: boolean };
}
export interface View {
  installed: Installed[]; catalog: Release[]; error: string | null; catalogError: string | null;
  localInstallAllowed: boolean;
  transfer: { busy: boolean; id: string | null; received: number; total: number | null; stage: string; error: string | null };
}
export const view = () => invoke<View>("plugins_view");
export const refresh = () => invoke<void>("plugins_refresh");
export const install = (id: string, version: string, local?: string) => invoke<void>("plugins_install", { id, version, local: local ?? null });
export const cancel = () => invoke<void>("plugins_cancel");
export const action = (id: string, action: string) => invoke<void>("plugins_action", { id, action });
export const command = (id: string, text: string) => invoke<{ text: string }>("plugins_command", { id, name: "greet", args: { text } });
export interface DotaSafety {
  runtime: { mode: "built_in" | "draining" | "external" | "fallback"; epoch: number | null; queued: number; inFlight: number; lost: number; error: string | null; activationBlocker: string | null };
  quota: { unknown: number; remainingOperations: number } | null;
  storageError: string | null;
}
export const dotaSafety = () => invoke<DotaSafety>("dota_runtime_safety_status");
export const dotaAction = (action: "prepare" | "enable" | "disable" | "recover", confirmed: boolean) => invoke<void>("dota_runtime_action", { action, confirmed });

export function errorText(error: unknown): string {
  const text = String(error);
  const messages: Record<string, string> = {
    cancelled: "Загрузка отменена. Установленная версия сохранена.",
    invalid_signature: "Подпись не прошла проверку. Плагин не установлен.",
    package_checksum_mismatch: "Пакет повреждён или отличается от подписанного каталога.",
    payload_checksum_mismatch: "Файлы плагина изменены. Запуск заблокирован.",
    incompatible_api: "Версия Plugin API несовместима с Companion.",
    incompatible_platform: "Пакет предназначен для другой системы или архитектуры.",
    stop_before_rollback: "Остановите плагин перед откатом.",
    transfer_in_progress: "Дождитесь завершения операции или отмените загрузку.",
    pending_update_exists: "Уже загружено обновление. Остановите плагин для активации.",
    incompatible_plugin: "Плагин сообщил другую версию или несовместимый API.",
    local_install_disabled: "Локальная установка доступна только в сборке для разработки.",
    use_rollback_for_older_version: "Для предыдущей версии используйте откат установленного плагина.",
    dota_live_activation_deferred: "Dota запускается только через безопасное ручное переключение runtime.",
    external_runtime_requires_windows_native_fences: "External Dota требует Windows и подтверждённых process/audio/OBS fences.",
    builtin_session_required: "Сначала начните сессию во встроенной Dota. External продолжит её с тем же идентификатором.",
    unknown_effects_require_explicit_reconciliation: "Есть эффекты с неопределённым результатом. Повторное исполнение и смена владельца заблокированы.",
    frontend_audio_fence_timeout: "WebView не подтвердил остановку игровых звуков. Twitch/TTS продолжает работать; переключение Dota заблокировано.",
    obs_fence_unconfirmed: "Не получен свежий ответ OBS. Переключение Dota заблокировано; проверьте OBS WebSocket.",
    backup_unavailable: "Сначала создайте проверенный backup кнопкой подготовки External Dota.",
  };
  if (text.includes("download_failed")) return "GitHub недоступен или пакет ещё не опубликован. Установленные плагины продолжают работать.";
  return messages[text] ?? text;
}
