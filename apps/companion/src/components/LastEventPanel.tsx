import type { LastEvent } from "../types/status";
import { formatTimestamp } from "../utils/format";

interface Props {
  event: LastEvent | null;
  requestCount: number;
}

export function LastEventPanel({ event, requestCount }: Props) {
  return (
    <div className="last-event">
      <h2>
        Последнее событие
        {requestCount > 0 && <span className="last-event__count"> (всего запросов: {requestCount})</span>}
      </h2>
      {event ? (
        <dl>
          <dt>Время</dt>
          <dd>{formatTimestamp(event.timestamp)}</dd>
          <dt>Источник</dt>
          <dd>{event.remote_addr}</dd>
          <dt>Сводка</dt>
          <dd>{event.summary}</dd>
        </dl>
      ) : (
        <p className="last-event__empty">Событий пока нет — GSI ничего не присылал.</p>
      )}
    </div>
  );
}
