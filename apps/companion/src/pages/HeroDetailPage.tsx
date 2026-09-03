import { useEffect, useState } from "react";
import { SoundBindingRow } from "../components/sounds/SoundBindingRow";
import { Badge } from "../components/ui";
import type { useFavoriteHeroes } from "../hooks/useFavoriteHeroes";
import { useHeroLocalStats } from "../hooks/useHeroLocalStats";
import type { GameSoundEventKind, GameSoundSettings, TrackedAbility, TrackedHero } from "../services/dotaCompanionApi";
import { getHeroById } from "../services/heroCatalog";
import type { HeroLocalStats, LocalMatchResultValue } from "../types/status";

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

const RESULT_LABEL: Record<LocalMatchResultValue, string> = {
  win: "Победа",
  loss: "Поражение",
  abandon: "Оставлен",
};

function formatAvg(value: number | null): string {
  return value === null ? "—" : value.toFixed(1);
}

// WK-140 - RIGHT zone: honest local statistics, not a dashboard. Typography
// + a compact recent-results row, no KPI tiles/charts/bordered panel - see
// this task's own "no boxed dashboard" requirement. Explicitly captioned as
// Companion's own local history (not lifetime Dota stats, and not yet
// enriched by OpenDota - see this component's data-boundary doc comment
// below) so the numbers are never mistaken for something they aren't.
function HeroStatsPanel({ stats }: { stats: HeroLocalStats | null }) {
  if (!stats) return null;

  if (stats.matches === 0) {
    return (
      <div className="hero-detail__stats">
        <h3 className="hero-detail__stats-title">Статистика</h3>
        <p className="hero-detail__stats-empty">Пока нет матчей в локальной истории</p>
      </div>
    );
  }

  const decided = stats.wins + stats.losses;
  const winrate = decided > 0 ? (stats.wins / decided) * 100 : null;
  const hasKda = stats.avgKills !== null || stats.avgDeaths !== null || stats.avgAssists !== null;

  return (
    <div className="hero-detail__stats">
      <h3 className="hero-detail__stats-title">Статистика</h3>
      <dl className="hero-detail__stats-list">
        <div className="hero-detail__stats-row"><dt>Матчи</dt><dd>{stats.matches}</dd></div>
        <div className="hero-detail__stats-row"><dt>Победы</dt><dd>{stats.wins}</dd></div>
        <div className="hero-detail__stats-row"><dt>Поражения</dt><dd>{stats.losses}</dd></div>
        <div className="hero-detail__stats-row"><dt>Винрейт</dt><dd>{winrate === null ? "—" : `${winrate.toFixed(1)}%`}</dd></div>
        {hasKda && (
          <div className="hero-detail__stats-row">
            <dt>Ср. K/D/A</dt>
            <dd>{formatAvg(stats.avgKills)} / {formatAvg(stats.avgDeaths)} / {formatAvg(stats.avgAssists)}</dd>
          </div>
        )}
      </dl>
      {stats.recentResults.length > 0 && (
        <div className="hero-detail__stats-recent" aria-label="Последние результаты на этом герое">
          {stats.recentResults.map((result, index) => (
            <span
              key={index}
              className={`hero-detail__stats-dot hero-detail__stats-dot--${result}`}
              title={RESULT_LABEL[result]}
            />
          ))}
        </div>
      )}
      <p className="hero-detail__stats-caption">Локальная история Companion</p>
    </div>
  );
}

export function HeroDetailPage({ heroId, favorites, trackedHero, settings, onBack, onChooseFile, onPreview, onRemove, stopPreview }: Props) {
  const [selectedAbilityId, setSelectedAbilityId] = useState<string | null>(null);
  const [videoFailed, setVideoFailed] = useState(false);
  const [visualUnavailable, setVisualUnavailable] = useState(false);
  const heroStats = useHeroLocalStats(heroId);

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
      {favorites.error && <p className="app__error">Ошибка: {favorites.error}</p>}

      {/* WK-140 - three compositional zones (identity/abilities LEFT, hero
          CENTER, statistics RIGHT), not three visible panels: the hero
          visual stays the scene's own large, centered, radial-masked
          background (see App.css) and LEFT/RIGHT content is laid out over
          it via `.hero-detail__grid`, not boxed containers. Replaces
          WK-133's single top-left content block, which deliberately left
          the right side open "for a future statistics block" - this is
          that block. */}
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

        <div className="hero-detail__grid">
          <div className="hero-detail__left">
            {/* WK-140 - moved off the page's own top row (where it read as
                a button floating centered above the hero) into the LEFT
                identity hierarchy, as a restrained breadcrumb. */}
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

          {/* WK-140 - RIGHT: local statistics. Deliberately a distinct
              component/prop boundary (HeroStatsPanel takes just the DTO, not
              the fetching hook) so a future OpenDota-backed source can hand
              it richer data later without this composition changing - see
              the task's data-boundary requirement. */}
          <div className="hero-detail__right">
            <HeroStatsPanel stats={heroStats} />
          </div>
        </div>
      </div>
    </div>
  );
}
