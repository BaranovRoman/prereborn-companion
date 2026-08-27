import { useState } from "react";
import { SoundBindingRow } from "./SoundBindingRow";
import { SoundModal } from "./SoundModal";
import type { GameSoundEventKind, GameSoundSettings, TrackedAbility, TrackedHero } from "../../services/dotaCompanionApi";

interface Props {
  hero: TrackedHero;
  settings: GameSoundSettings;
  onClose: () => void;
  onChooseFile: (eventId: string, kind: GameSoundEventKind) => Promise<void>;
  onPreview: (assetId: string) => Promise<void>;
  onRemove: (eventId: string) => Promise<void>;
}

function statusLabel(ability: TrackedAbility): string {
  if (ability.status === "unsupported") return `${ability.displayName}: ${ability.reason}`;
  if (ability.status === "experimental") return `${ability.displayName} (экспериментально): ${ability.reason}`;
  return ability.displayName;
}

// WK-108 - redesigned from a vertical settings list to a horizontal,
// Dota-style ability bar: square icon cards in a wrapping row (heroes with
// many abilities, e.g. Invoker's 14, wrap onto a second/third row instead of
// ever going vertical). Clicking a card opens the same existing Выбрать/
// Прослушать/Удалить flow (SoundBindingRow) inline below the bar, so there's
// exactly one binding editor open at a time rather than one full-height
// control block per ability like the old layout had.
//
// Each card also now reflects the WK-108 tri-state status instead of a
// plain supported/unsupported boolean: unsupported cards stay grayscale and
// non-interactive (as before); experimental cards are interactive/bindable
// but carry a distinct dashed marker + tooltip so the user knows this
// ability's cast detection is a best-effort guess, not a proven signal (see
// catalog.rs's module doc comment - metadata alone can never earn
// "supported").
export function HeroAbilitiesModal({ hero, settings, onClose, onChooseFile, onPreview, onRemove }: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = hero.abilities.find((a) => a.id === selectedId) ?? null;

  return (
    <SoundModal title={hero.displayName} onClose={onClose} wide={hero.abilities.length > 6}>
      <div className="hero-ability-bar">
        {hero.abilities.map((ability) => {
          const bound = settings.bindings.some((b) => b.eventId === ability.id && b.kind === "abilityCast");
          const disabled = ability.status === "unsupported";
          const isSelected = ability.id === selectedId;
          return (
            <button
              key={ability.id}
              type="button"
              className={[
                "hero-ability-card",
                `hero-ability-card--${ability.status}`,
                bound ? "hero-ability-card--bound" : "",
                isSelected ? "hero-ability-card--selected" : "",
              ].filter(Boolean).join(" ")}
              disabled={disabled}
              title={statusLabel(ability)}
              onClick={() => setSelectedId(isSelected ? null : ability.id)}
            >
              <img className="hero-ability-card__icon" src={ability.iconUrl} alt="" width={48} height={48} />
              <span className="hero-ability-card__name">{ability.displayName}</span>
              {ability.status === "experimental" && <span className="hero-ability-card__flag" aria-hidden="true">?</span>}
              {bound && <span className="hero-ability-card__bound-dot" aria-hidden="true" />}
            </button>
          );
        })}
      </div>

      {selected && (
        <div className="hero-ability-detail">
          <div className="hero-ability-detail__header">
            <strong>{selected.displayName}</strong>
            {selected.status === "experimental" && (
              <small className="hero-ability-detail__caveat">Экспериментально — {selected.reason}</small>
            )}
          </div>
          <SoundBindingRow
            eventId={selected.id}
            kind="abilityCast"
            masterVolume={settings.masterVolume}
            binding={settings.bindings.find((b) => b.eventId === selected.id && b.kind === "abilityCast")}
            assets={settings.assets}
            onChooseFile={onChooseFile}
            onPreview={onPreview}
            onRemove={onRemove}
          />
        </div>
      )}
    </SoundModal>
  );
}
