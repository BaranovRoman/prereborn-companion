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

interface AbilityColumnProps {
  align: "left" | "right";
  abilities: TrackedAbility[];
  settings: GameSoundSettings;
  selectedAbilityId: string | null;
  onSelect: (id: string | null) => void;
  onChooseFile: Props["onChooseFile"];
  onPreview: Props["onPreview"];
  onRemove: Props["onRemove"];
}

// Each row surfaces the full assignment state up front (icon, name, support
// state, bound file) - only the three action buttons (Выбрать/Прослушать/
// Удалить) stay behind a single click, via the same inline SoundBindingRow
// HeroDetailPage always used (no modal). Splitting the hero's ability list
// across two columns is what lets the hero visual sit at the horizontal
// center of the workspace (see §3 of this slice's brief) instead of pushing
// everything below a full-width video row.
function AbilityColumn({ align, abilities, settings, selectedAbilityId, onSelect, onChooseFile, onPreview, onRemove }: AbilityColumnProps) {
  return (
    <div className={`hero-ability-column hero-ability-column--${align}`}>
      {abilities.map((ability) => {
        const binding = settings.bindings.find((b) => b.eventId === ability.id && b.kind === "abilityCast");
        const asset = binding ? settings.assets.find((a) => a.id === binding.assetId) : undefined;
        const disabled = ability.status === "unsupported";
        const isSelected = ability.id === selectedAbilityId;

        let stateLabel: string;
        if (ability.status === "unsupported") stateLabel = "Недоступно";
        else if (binding) stateLabel = asset ? asset.originalName : "Звук назначен";
        else if (ability.status === "experimental") stateLabel = "Экспериментально";
        else stateLabel = "Звук не назначен";

        return (
          <div key={ability.id} className="hero-ability-item">
            <button
              type="button"
              className={[
                "hero-ability-row",
                `hero-ability-row--${ability.status}`,
                binding ? "hero-ability-row--bound" : "",
                isSelected ? "hero-ability-row--selected" : "",
              ].filter(Boolean).join(" ")}
              disabled={disabled}
              title={statusLabel(ability)}
              onClick={() => onSelect(isSelected ? null : ability.id)}
            >
              <img className="hero-ability-row__icon" src={ability.iconUrl} alt="" width={40} height={40} />
              <span className="hero-ability-row__meta">
                <span className="hero-ability-row__name">{ability.displayName}</span>
                <span className="hero-ability-row__state">{stateLabel}</span>
              </span>
              {ability.status === "experimental" && <span className="hero-ability-row__flag" aria-hidden="true">?</span>}
              {binding && <span className="hero-ability-row__bound-dot" aria-hidden="true" />}
            </button>
            {isSelected && (
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
            )}
          </div>
        );
      })}
    </div>
  );
}

// WK-123 - Hero Detail rebuilt around a three-part horizontal composition
// (left abilities / hero visual / right abilities) instead of the previous
// full-width video "scene" with abilities stacked below it: that shape left
// the assignment workflow (the actual point of this screen) below the fold
// on common desktop sizes, with the video reading as a giant player card
// rather than the hero simply being present in the interface. The hero's
// own ability list (`trackedHero.abilities`, same order the Rust catalog
// returns them in) is split in half so both columns flank the visual and
// stay in original order end-to-end when the layout collapses to one column
// under 1200px (see `.hero-detail__workspace`'s media query in App.css) -
// there is no separate "left" vs "right" ability grouping, it is purely a
// spatial split of one ordered list. Video is masked with a soft radial
// fade (no rectangular border/background box) so it reads as hero artwork
// embedded in the workspace rather than a bordered video player - same
// lazy/muted/looping/poster-fallback video element as before, only mounted
// while this hero's page is open.
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
  const abilities = trackedHero?.abilities ?? [];
  const splitAt = Math.ceil(abilities.length / 2);
  const leftAbilities = abilities.slice(0, splitAt);
  const rightAbilities = abilities.slice(splitAt);

  return (
    <div className="hero-detail">
      <div className="hero-detail__topbar">
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

      <h3 className="ui-settings-group__title">Способности</h3>
      {!trackedHero || !settings ? (
        <p className="heroes-grid__empty">Загрузка каталога звуков…</p>
      ) : (
        <div className="hero-detail__workspace">
          <AbilityColumn
            align="left"
            abilities={leftAbilities}
            settings={settings}
            selectedAbilityId={selectedAbilityId}
            onSelect={setSelectedAbilityId}
            onChooseFile={onChooseFile}
            onPreview={onPreview}
            onRemove={onRemove}
          />

          <div className="hero-detail__visual">
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
              <img src={hero.portraitUrl} alt="" />
            )}
          </div>

          <AbilityColumn
            align="right"
            abilities={rightAbilities}
            settings={settings}
            selectedAbilityId={selectedAbilityId}
            onSelect={setSelectedAbilityId}
            onChooseFile={onChooseFile}
            onPreview={onPreview}
            onRemove={onRemove}
          />
        </div>
      )}
    </div>
  );
}
