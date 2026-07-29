import type { LastEvent } from "../types/status";
import { formatTimestamp } from "../utils/format";

interface Props {
  events: LastEvent[];
}

export function EventHistoryList({ events }: Props) {
  if (events.length === 0) return null;

  return (
    <section className="event-history">
      <h2>История событий (последние {Math.min(events.length, 10)})</h2>
      <ul>
        {events.slice(0, 10).map((event, index) => (
          <li key={`${event.timestamp}-${index}`}>
            <span className="event-history__time">{formatTimestamp(event.timestamp)}</span>
            <span className="event-history__summary">{event.summary}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
