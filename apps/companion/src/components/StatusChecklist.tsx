import type { StatusSnapshot } from "../types/status";
import { shortenPath } from "../utils/format";

interface CheckItemProps {
  ok: boolean;
  label: string;
  detail?: string;
}

function CheckItem({ ok, label, detail }: CheckItemProps) {
  return (
    <li className={`check-item${ok ? " check-item--ok" : ""}`}>
      <span className="check-item__box">{ok ? "✔" : ""}</span>
      <span className="check-item__label">{label}</span>
      {detail && <span className="check-item__detail">{shortenPath(detail)}</span>}
    </li>
  );
}

interface Props {
  status: StatusSnapshot | null;
}

export function StatusChecklist({ status }: Props) {
  return (
    <ul className="status-checklist">
      <CheckItem
        ok={!!status?.dota_found}
        label="Dota найдена"
        detail={status?.dota_path ? `${status.dota_path} (${status.dota_source})` : undefined}
      />
      <CheckItem
        ok={!!status?.gsi_installed}
        label="GSI конфиг установлен"
        detail={status?.gsi_config_path ?? undefined}
      />
      <CheckItem
        ok={!!status?.server_running}
        label={status ? `Локальный сервер запущен (порт ${status.server_port})` : "Локальный сервер запущен"}
      />
    </ul>
  );
}
