import { useEffect, useState } from "react";
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
  stopPreview: () => void;
}

const ATTRIBUTE_LABEL: Record<string, string> = {
  strength: "Сила",
  agility: "Ловкость",
  intelligence: "Интеллект",
  universal: "Универсальный",
};

function tooltipLines(ability: TrackedAbility, binding: boolean, assetName: string | undefined): string[] {
  const lines = [ability.displayName];
  if (ability.status === "unsupported") lines.push(`Недоступно${ability.reason ? `: ${ability.reason}` : ""}`);
  else if (ability.status === "experimental") lines.push(`Экспериментально${ability.reason ? `: ${ability.reason}` : ""}`);
  if (binding) lines.push(assetName ? `Звук: ${assetName}` : "Звук назначен");
  else if (ability.status !== "unsupported") lines.push("Звук не назначен");
  return lines;
}

interface AbilityStripProps {
  abilities: TrackedAbility[];
  settings: GameSoundSettings;
  selectedAbilityId: string | null;
  onSelect: (id: string | null) => void;
}

// WK-134 - never the browser's native broken-image glyph: swap to a quiet
// neutral fallback (no text, same box) if the icon URL 404s/fails to load.
function AbilityIconImage({ src }: { src: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <span className="hero-ability-icon__img-fallback" aria-hidden="true" />;
  return <img src={src} alt="" width={56} height={56} onError={() => setFailed(true)} />;
}

// WK-134 - viewport-edge collision: the tooltip bubble normally centers
// under its icon, which clips off-screen for icons near the left/right
// edge. Flex-wrap means row membership (and so which icons are actually
// edge-adjacent) isn't knowable from CSS alone, so this measures on
// hover/focus and flips the bubble's anchor via a data attribute the CSS
// reads (see `.hero-ability-icon[data-tooltip-align]` in App.css).
const TOOLTIP_EDGE_MARGIN = 132;
function positionTooltip(event: { currentTarget: HTMLButtonElement }) {
  const el = event.currentTarget;
  if (el.getBoundingClientRect().left < TOOLTIP_EDGE_MARGIN) el.dataset.tooltipAlign = "start";
  else if (window.innerWidth - el.getBoundingClientRect().right < TOOLTIP_EDGE_MARGIN) el.dataset.tooltipAlign = "end";
  else delete el.dataset.tooltipAlign;
}

// WK-133 - the resting Hero Detail screen must read as a Dota ability bar,
// not a settings form: every ability is just its icon (no name/status text
// permanently on screen, no per-ability card background) with tri-state
// conveyed through opacity/outline/a small corner marker, and full detail
// only on hover/focus via the tooltip. Reuses the existing `.ui-tooltip`/
// `.ui-tooltip__bubble` recipe directly on the button itself (rather than
// Tooltip.tsx's extra wrapping span) so a dense kit like Invoker's doesn't
// get a second empty tab stop per ability - `:focus-within` already matches
// an element that is itself focused, so this needs no JS.
function AbilityStrip({ abilities, settings, selectedAbilityId, onSelect }: AbilityStripProps) {
  return (
    <div className="hero-ability-strip">
      {abilities.map((ability) => {
        const binding = settings.bindings.find((b) => b.eventId === ability.id && b.kind === "abilityCast");
        const asset = binding ? settings.assets.find((a) => a.id === binding.assetId) : undefined;
        const disabled = ability.status === "unsupported";
        const isSelected = ability.id === selectedAbilityId;
        const lines = tooltipLines(ability, !!binding, asset?.originalName);

        return (
          <button
            key={ability.id}
            type="button"
            className={[
              "hero-ability-icon",
              "ui-tooltip",
              `hero-ability-icon--${ability.status}`,
              binding ? "hero-ability-icon--bound" : "",
              isSelected ? "hero-ability-icon--selected" : "",
            ].filter(Boolean).join(" ")}
            disabled={disabled}
            aria-label={lines.join(". ")}
            onClick={() => onSelect(isSelected ? null : ability.id)}
            onMouseEnter={positionTooltip}
            onFocus={positionTooltip}
          >
            <AbilityIconImage src={ability.iconUrl} />
            {ability.status === "experimental" && <span className="hero-ability-icon__flag" aria-hidden="true">?</span>}
            {binding && <span className="hero-ability-icon__bound-dot" aria-hidden="true" />}
            <span className="ui-tooltip__bubble" role="tooltip">
              {lines.map((line, i) => (
                <span key={i} className={i === 0 ? "hero-ability-icon__tooltip-name" : "hero-ability-icon__tooltip-line"}>
                  {line}
                </span>
              ))}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function HeroDetailPage({ heroId, favorites, trackedHero, settings, onBack, onChooseFile, onPreview, onRemove, stopPreview }: Props) {
  const [selectedAbilityId, setSelectedAbilityId] = useState<string | null>(null);
  const [videoFailed, setVideoFailed] = useState(false);
  const [visualUnavailable, setVisualUnavailable] = useState(false);

  // WK-132 - a preview started here must not keep playing after the user
  // navigates away, whether via the back button or by switching to another
  // section entirely (both just unmount this component - there's no shared
  // "leaving" event besides that). onChooseFile already stops a *running*
  // preview before importing a new file; this covers plain navigation.
  useEffect(() => stopPreview, [stopPreview]);

  // WK-133 - Escape collapses the expanded sound control, mirroring the
  // same "Escape closes the transient thing" idiom HeroesPage's search uses.
  useEffect(() => {
    if (!selectedAbilityId) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelectedAbilityId(null);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selectedAbilityId]);

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
  const abilities = trackedHero?.abilities ?? [];
  const selectedAbility = abilities.find((a) => a.id === selectedAbilityId) ?? null;
  const selectedBinding = selectedAbility && settings
    ? settings.bindings.find((b) => b.eventId === selectedAbility.id && b.kind === "abilityCast")
    : undefined;

  return (
    <div className="hero-detail">
      <button className="ui-button ui-button--ghost hero-detail__back" onClick={onBack}>← Герои</button>
      {favorites.error && <p className="app__error">Ошибка: {favorites.error}</p>}

      {/* WK-133 - the hero visual is now the scene's own large background
          (radial-masked, feathered into the app's ambient fog/ember layer
          behind it - see App.css), not a bounded video card - foreground
          content (name, ability strip, expanded control) is anchored to the
          top-left over it, deliberately leaving the right side open for a
          future statistics block instead of stretching content full-width. */}
      <div className="hero-detail__scene">
        {!visualUnavailable && (
          <div className="hero-detail__visual-bg" aria-hidden="true">
            {!videoFailed ? (
              <video
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
              <img src={hero.portraitUrl} alt="" onError={() => setVisualUnavailable(true)} />
            )}
          </div>
        )}

        <div className="hero-detail__content">
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

          {!trackedHero || !settings ? (
            <p className="hero-detail__loading">Загрузка способностей…</p>
          ) : (
            <>
              <AbilityStrip
                abilities={abilities}
                settings={settings}
                selectedAbilityId={selectedAbilityId}
                onSelect={setSelectedAbilityId}
              />

              {selectedAbility && (
                <div className="hero-ability-expanded">
                  <span className="hero-ability-expanded__name">{selectedAbility.displayName}</span>
                  <SoundBindingRow
                    eventId={selectedAbility.id}
                    kind="abilityCast"
                    masterVolume={settings.masterVolume}
                    binding={selectedBinding}
                    assets={settings.assets}
                    onChooseFile={onChooseFile}
                    onPreview={onPreview}
                    onRemove={onRemove}
                  />
                </div>
              )}

              {!settings.enabled && (
                // WK-133 §13 - a subtle inline line near the strip, not the
                // previous detached full-width banner - assignment/preview
                // stay fully usable, this is informational only.
                <p className="hero-detail__sounds-disabled-hint">Звуковые реакции выключены</p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
