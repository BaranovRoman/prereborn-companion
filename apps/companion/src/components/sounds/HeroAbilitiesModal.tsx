import { SoundBindingRow } from "./SoundBindingRow";
import { SoundModal } from "./SoundModal";
import type { GameSoundEventKind, GameSoundSettings, TrackedHero } from "../../services/dotaCompanionApi";

interface Props {
  hero: TrackedHero;
  settings: GameSoundSettings;
  onClose: () => void;
  onChooseFile: (eventId: string, kind: GameSoundEventKind) => Promise<void>;
  onPreview: (assetId: string) => Promise<void>;
  onRemove: (eventId: string) => Promise<void>;
}

// задача п.3's Pudge worked example - Meat Hook / Rot / Flesh Heap /
// Dismember, each with icon/name/support status and its own Выбрать/
// Прослушать/Удалить controls. Rot and Flesh Heap render as unsupported
// (see catalog.rs - toggle without a cooldown, and a passive respectively)
// rather than pretending every ability in hero metadata is castable.
export function HeroAbilitiesModal({ hero, settings, onClose, onChooseFile, onPreview, onRemove }: Props) {
  return (
    <SoundModal title={hero.displayName} onClose={onClose}>
      <ul className="hero-abilities-modal__list">
        {hero.abilities.map((ability) => {
          const binding = settings.bindings.find((b) => b.eventId === ability.id && b.kind === "abilityCast");
          return (
            <li
              key={ability.id}
              className={`hero-ability-row ${ability.supported ? "" : "hero-ability-row--unsupported"}`}
            >
              <img className="hero-ability-row__icon" src={ability.iconUrl} alt="" width={40} height={40} />
              <div className="hero-ability-row__info">
                <strong>{ability.displayName}</strong>
                {!ability.supported && <small title={ability.reason ?? undefined}>{ability.reason}</small>}
              </div>
              {ability.supported ? (
                <SoundBindingRow
                  eventId={ability.id}
                  kind="abilityCast"
                  masterVolume={settings.masterVolume}
                  binding={binding}
                  assets={settings.assets}
                  onChooseFile={onChooseFile}
                  onPreview={onPreview}
                  onRemove={onRemove}
                />
              ) : (
                <span className="hero-ability-row__unsupported-label">Недоступно для отслеживания</span>
              )}
            </li>
          );
        })}
      </ul>
    </SoundModal>
  );
}
