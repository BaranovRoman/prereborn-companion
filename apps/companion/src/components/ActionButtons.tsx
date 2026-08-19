interface Props {
  busy: boolean;
  canOpenDotaFolder: boolean;
  legacyCleanupInProgress: boolean;
  onInstallGsi: () => void;
  onPickFolder: () => void;
  onOpenDotaFolder: () => void;
  onOpenLogs: () => void;
  onClearLog: () => void;
  onRefresh: () => void;
}

export function ActionButtons({
  busy,
  canOpenDotaFolder,
  legacyCleanupInProgress,
  onInstallGsi,
  onPickFolder,
  onOpenDotaFolder,
  onOpenLogs,
  onClearLog,
  onRefresh,
}: Props) {
  return (
    <div className="action-buttons">
      <button onClick={onInstallGsi} disabled={busy}>
        Установить GSI
      </button>
      <button onClick={onPickFolder} disabled={busy}>
        Выбрать папку Dota вручную
      </button>
      <button onClick={onOpenDotaFolder} disabled={busy || !canOpenDotaFolder}>
        Открыть папку Dota
      </button>
      <button onClick={onOpenLogs} disabled={busy}>
        Открыть папку логов
      </button>
      <button onClick={onClearLog} disabled={busy || legacyCleanupInProgress}>
        {legacyCleanupInProgress ? "Очистка выполняется…" : "Очистить лог"}
      </button>
      <button onClick={onRefresh} disabled={busy}>
        Обновить статус
      </button>
    </div>
  );
}
