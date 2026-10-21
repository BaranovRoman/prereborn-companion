import { invoke } from "@tauri-apps/api/core";
export interface Manifest {
  id: string; name: string; description: string; version: string; platform: string; arch: string;
  minApi: number; maxApi: number; ui: string; permissions: string[];
  author?: string; icon?: string; uiCommands?: string[];
  execution?: "live" | "replay_only";
}
export interface Release { manifest: Manifest; url: string; sha256: string; signature: string }
export interface Runtime { phase: "running" | "starting" | "stopped" | "failed"; pluginVersion?: string|null; lastError: string | null; state: unknown }
export interface Installed {
  id: string; manifest: Manifest | null; error: string | null; runtime: Runtime | null;
  transport?: unknown;
  installed: { active: string; previous: string | null; pending: string | null; enabled: boolean };
}
export interface View {
  apiVersion?: number;
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
export const request = (id: string, name: string, args: unknown, expectedVersion:string) => invoke<unknown>("plugins_command", { id, name, args,expectedVersion });

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
    plugin_update_required: "Для запуска требуется совместимая обновлённая версия пакета.",
    stale_ui_package: "Версия плагина изменилась. Откройте его страницу заново.",
    previous_process_stop_unproven: "Остановка предыдущего процесса плагина не подтверждена. Нажмите «Проверить остановку и восстановить».",
    plugin_process_requires_recovery: "Процесс плагина остановился. Нажмите «Проверить остановку и восстановить».",
    process_fence_unproven: "Не удалось подтвердить завершение предыдущего процесса плагина. Перезапустите Companion; если ошибка повторится, перезагрузите Windows.",
    backend_reconciliation_inconclusive: "Не удалось подтвердить сохранение настроек на сервере. Проверьте подключение аккаунта и повторите восстановление.",
    account_not_connected: "Аккаунт не подключён. Подключите аккаунт и повторите операцию.",
    unknown_effects_require_explicit_reconciliation: "Есть действия с неподтверждённым результатом. Требуется восстановление плагина.",
    frontend_process_uncontained: "Процесс воспроизведения не прошёл native-проверку. Запуск заблокирован.",
    frontend_containment_unproven: "Не удалось подтвердить безопасность процесса воспроизведения.",
    transport_quota_headroom_required: "Недостаточно свободной квоты для безопасного запуска. Проверьте диагностику runtime.",
    obs_fence_unconfirmed: "Не получено подтверждение состояния OBS. Проверьте WebSocket и выполните восстановление.",
    backup_unavailable: "Сначала создайте проверенный backup кнопкой подготовки плагина.",
    backup_already_exists: "Backup уже существует, но подготовка не подтверждена. Сохраните файл; проверьте причину ошибки.",
    source_changed_after_backup: "Данные изменились между backup и подготовкой. Backup сохранён; операция не завершена.",
    second_coordinator_denied: "Хранилище занято другим координатором. Конкурентная подготовка запрещена.",
    prepare_in_progress: "Предыдущая подготовка ещё выполняется.",
  };
  if (text.includes("download_failed")) return "Источник загрузки недоступен или пакет ещё не опубликован. Установленные пакеты сохранены; состояние запуска показано отдельно.";
  const code = text.replace(/^Error: /, "");
  // "<cause>; stop: <stop error>" - the cause is what the user acts on; the
  // full chain stays in the plugin diagnostics.
  return messages[code] ?? messages[code.split("; stop: ")[0]] ?? text;
}

const RECOVERY_CODES = ["previous_process_stop_unproven", "plugin_process_requires_recovery", "unknown_effects_require_explicit_reconciliation", "obs_fence_unconfirmed"];
export function needsRecovery(plugin: Installed): boolean {
  const code = String(plugin.error ?? "").replace(/^Error: /, "");
  return plugin.runtime?.phase === "failed" || RECOVERY_CODES.some((c) => code === c || code.startsWith(`${c}; stop: `) || code.includes(`; stop: ${c}`));
}
export function stateText(plugin: Installed): string {
  if (needsRecovery(plugin)) return "Требуется восстановление";
  if (!plugin.installed.enabled) return "Отключён";
  return { running: "Работает", starting: "Запускается", stopped: "Остановлен", failed: "Ошибка процесса" }[plugin.runtime?.phase ?? "stopped"];
}
