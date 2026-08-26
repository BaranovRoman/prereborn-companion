import type { GameSoundSettings, TrackedItem } from "../../services/dotaCompanionApi";

interface Props {
  items: TrackedItem[];
  settings: GameSoundSettings;
  onSelect: (item: TrackedItem) => void;
}

// Dota shop-grid-inspired, three visual states (задача п.2):
//  1. unsupported - grayscale, not clickable, tooltip explains why.
//  2. supported, no sound configured yet - normal icon.
//  3. sound configured - a visible but not shouty "configured" accent.
export function ItemsGrid({ items, settings, onSelect }: Props) {
  return (
    <div className="sound-grid" role="list">
      {items.map((item) => {
        const configured = settings.bindings.some((b) => b.eventId === item.id && b.kind === "itemUsed");
        const state = !item.supported ? "unsupported" : configured ? "configured" : "supported";
        return (
          <button
            key={item.id}
            type="button"
            role="listitem"
            className={`sound-tile sound-tile--${state}`}
            disabled={!item.supported}
            title={item.supported ? item.displayName : `${item.displayName}: ${item.reason}`}
            onClick={() => onSelect(item)}
          >
            <img className="sound-tile__icon" src={item.iconUrl} alt="" width={44} height={33} loading="lazy" />
            <span className="sound-tile__label">{item.displayName}</span>
            {configured && <span className="sound-tile__badge" aria-hidden="true">♪</span>}
          </button>
        );
      })}
    </div>
  );
}
