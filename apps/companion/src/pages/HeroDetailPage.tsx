import { useState } from "react";
import { SoundBindingRow } from "../components/sounds/SoundBindingRow";
import { Badge } from "../components/ui";
import type { useFavoriteHeroes } from "../hooks/useFavoriteHeroes";
import type { GameSoundEventKind, GameSoundSettings, TrackedAbility, TrackedHero } from "../services/dotaCompanionApi";
import { getHeroById } from "../services/heroCatalog";

interface Props {
  heroId: number;
  favorites: ReturnType<typeof useFavoriteHeroes>;
  trackedHero: TrackedHero | null;
  settings: GameSoundSettings | null;
  onBack: () => void;
  onChooseFile: (eventId: string, kind: GameSoundEventKind) => Promise<void>;
  onPreview: (assetId: string) => Promise<void>;
  onRemove: (eventId: string) => Promise<void>;
}

const ATTRIBUTE_LABEL: Record<string, string> = {
  strength: "Сила",
  agility: "Ловкость",
  intelligence: "Интеллект",
  universal: "Универсальный",
};

function statusLabel(ability: TrackedAbility): string {
  if (ability.status === "unsupported") return `${ability.displayName}: ${ability.reason}`;
  if (ability.status === "experimental") return `${ability.displayName} (экспериментально): ${ability.reason}`;
  return ability.displayName;
}

// WK-121/WK-122 §10 - hero opens as a full workspace page, not a modal.
// The hero video is the SCENE's background, not a card in the document
// flow: it fills `.hero-detail__scene` absolutely (object-fit: cover),
// with the back link and name/favorite/attribute identity layered on top
// of it (over a top scrim for legibility) rather than stacked above/below
// it as separate blocks - see this slice's research doc §"Hero detail —
// пересобрать композицию" for why the previous sequential
// back→video-card→header layout didn't satisfy this. Video is a lazy,
// muted, looping element (production media host - same production-
// acceptable assets apps/web already serves, see heroCatalog.ts's doc
// comment) with the existing portrait as `poster` and as the fallback if
// the video fails to load/decode - only ever mounted while this specific
// hero's page is open (HomePage's own section switch unmounts it), so
// Companion never holds more than one hero video alive at once. Ability
// sound assignment (below the scene, not overlaid on it - a compact bar
// stays legible against any hero's video) reuses the exact same
// SoundBindingRow/game-sounds commands the Sounds → Heroes flow already
// used - no parallel sound-mapping model.
export function HeroDetailPage({ heroId, favorites, trackedHero, settings, onBack, onChooseFile, onPreview, onRemove }: Props) {
  const [selectedAbilityId, setSelectedAbilityId] = useState<string | null>(null);
  const [videoFailed, setVideoFailed] = useState(false);

  const hero = getHeroById(heroId);
  if (!hero) {
    return (
      <div className="hero-detail">
        <button className="ui-button ui-button--ghost hero-detail__back" onClick={onBack}>← Герои</button>
        <p className="app__error">Герой не найден.</p>
      </div>
    );
  }

  const isFavorite = favorites.heroIds.includes(hero.id);
  const selectedAbility = trackedHero?.abilities.find((a) => a.id === selectedAbilityId) ?? null;

  return (
    <div className="hero-detail">
      <div className="hero-detail__scene">
        {!videoFailed ? (
          <video
            className="hero-detail__video"
            key={hero.videoUrl}
            src={hero.videoUrl}
            poster={hero.portraitUrl}
            muted
            autoPlay
            loop
            playsInline
            onError={() => setVideoFailed(true)}
          />
        ) : (
          <img className="hero-detail__poster" src={hero.portraitUrl} alt="" />
        )}
        <div className="hero-detail__scrim" aria-hidden="true" />

        <button className="ui-button ui-button--ghost hero-detail__back" onClick={onBack}>← Герои</button>

        <div className="hero-detail__identity">
          <h2>{hero.localizedName}</h2>
          <button
            type="button"
            className={`hero-detail__favorite ${isFavorite ? "is-active" : ""}`}
            aria-label={isFavorite ? "Убрать из избранного" : "Добавить в избранное"}
            disabled={favorites.busyId === hero.id}
            onClick={() => void favorites.toggle(hero.id)}
          >
            ★
          </button>
          <Badge tone="gold">{ATTRIBUTE_LABEL[hero.attribute]}</Badge>
        </div>
      </div>
      {favorites.error && <p className="app__error">Ошибка: {favorites.error}</p>}

      <section className="hero-detail__abilities">
        <h3 className="ui-settings-group__title">Способности</h3>
        {!trackedHero || !settings ? (
          <p className="heroes-grid__empty">Загрузка каталога звуков…</p>
        ) : (
          <>
            <div className="hero-ability-bar">
              {trackedHero.abilities.map((ability) => {
                const bound = settings.bindings.some((b) => b.eventId === ability.id && b.kind === "abilityCast");
                const disabled = ability.status === "unsupported";
                const isSelected = ability.id === selectedAbilityId;
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
                    onClick={() => setSelectedAbilityId(isSelected ? null : ability.id)}
                  >
                    <img className="hero-ability-card__icon" src={ability.iconUrl} alt="" width={48} height={48} />
                    <span className="hero-ability-card__name">{ability.displayName}</span>
                    {ability.status === "experimental" && <span className="hero-ability-card__flag" aria-hidden="true">?</span>}
                    {bound && <span className="hero-ability-card__bound-dot" aria-hidden="true" />}
                  </button>
                );
              })}
            </div>

            {selectedAbility && (
              <div className="hero-ability-detail">
                <div className="hero-ability-detail__header">
                  <strong>{selectedAbility.displayName}</strong>
                  {selectedAbility.status === "experimental" && (
                    <small className="hero-ability-detail__caveat">Экспериментально — {selectedAbility.reason}</small>
                  )}
                </div>
                <SoundBindingRow
                  eventId={selectedAbility.id}
                  kind="abilityCast"
                  masterVolume={settings.masterVolume}
                  binding={settings.bindings.find((b) => b.eventId === selectedAbility.id && b.kind === "abilityCast")}
                  assets={settings.assets}
                  onChooseFile={onChooseFile}
                  onPreview={onPreview}
                  onRemove={onRemove}
                />
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
