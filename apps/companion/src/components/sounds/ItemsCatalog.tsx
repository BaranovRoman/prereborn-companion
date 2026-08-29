import { useMemo, useState } from "react";
import { SoundBindingRow } from "./SoundBindingRow";
import { Badge } from "../ui";
import {
  categoryOf, ITEM_CATEGORY_GROUP, ITEM_CATEGORY_GROUP_LABEL, ITEM_CATEGORY_LABEL, ITEM_CATEGORY_ORDER,
  type ItemCategory, type ItemCategoryGroup,
} from "../../services/itemCategories";
import type { GameSoundEventKind, GameSoundSettings, TrackedItem } from "../../services/dotaCompanionApi";

interface Props {
  items: TrackedItem[];
  settings: GameSoundSettings;
  onChooseFile: (eventId: string, kind: GameSoundEventKind) => Promise<void>;
  onPreview: (assetId: string) => Promise<void>;
  onRemove: (eventId: string) => Promise<void>;
}

const GROUP_ORDER: ItemCategoryGroup[] = ["basics", "upgrades", "neutral"];

// WK-122 §13/§14 - "Предметы" catalog rebuilt from a flat uncategorized
// grid + per-click modal (the old ItemsGrid/ItemSoundModal) into a real
// Dota-shop-style master/detail: the catalog itself is grouped by real shop
// category (itemCategories.ts - grouping cross-checked against OpenDota's
// item constants, documented per-entry there), taking the main width; a
// PERSISTENT right-side inspector (not a modal) shows whatever item is
// currently selected and reuses the exact same SoundBindingRow the old
// modal did - no parallel sound-mapping model. An unsupported item stays
// browsable (it's still in the catalog, just visually muted, matching
// ItemsGrid's existing three-state treatment) and the inspector says
// plainly that the automatic event isn't supported yet - never fake
// support by hiding it or letting you bind a sound that will never play.
export function ItemsCatalog({ items, settings, onChooseFile, onPreview, onRemove }: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(items[0]?.id ?? null);

  const grouped = useMemo(() => {
    const byCategory = new Map<ItemCategory, TrackedItem[]>();
    for (const item of items) {
      const category = categoryOf(item.id);
      const list = byCategory.get(category) ?? [];
      list.push(item);
      byCategory.set(category, list);
    }
    const byGroup = new Map<ItemCategoryGroup, { category: ItemCategory; items: TrackedItem[] }[]>();
    for (const category of ITEM_CATEGORY_ORDER) {
      const categoryItems = byCategory.get(category);
      if (!categoryItems || categoryItems.length === 0) continue;
      const group = ITEM_CATEGORY_GROUP[category];
      const list = byGroup.get(group) ?? [];
      list.push({ category, items: categoryItems });
      byGroup.set(group, list);
    }
    return byGroup;
  }, [items]);

  const selectedItem = items.find((item) => item.id === selectedId) ?? null;
  const binding = selectedItem
    ? settings.bindings.find((b) => b.eventId === selectedItem.id && b.kind === "itemUsed")
    : undefined;

  return (
    <div className="items-catalog">
      <div className="items-catalog__grid" role="list">
        {GROUP_ORDER.map((group) => {
          const categories = grouped.get(group);
          if (!categories || categories.length === 0) return null;
          return (
            <section key={group} className="items-catalog__group">
              <h3 className="items-catalog__group-title">{ITEM_CATEGORY_GROUP_LABEL[group]}</h3>
              {categories.map(({ category, items: categoryItems }) => (
                <div key={category} className="items-catalog__category">
                  <h4 className="items-catalog__category-title">{ITEM_CATEGORY_LABEL[category]}</h4>
                  <div className="sound-grid">
                    {categoryItems.map((item) => {
                      const configured = settings.bindings.some((b) => b.eventId === item.id && b.kind === "itemUsed");
                      const state = !item.supported ? "unsupported" : configured ? "configured" : "supported";
                      return (
                        <button
                          key={item.id}
                          type="button"
                          role="listitem"
                          className={`sound-tile sound-tile--${state} ${item.id === selectedId ? "is-selected" : ""}`}
                          title={item.displayName}
                          onClick={() => setSelectedId(item.id)}
                        >
                          <img className="sound-tile__icon" src={item.iconUrl} alt="" width={44} height={33} loading="lazy" />
                          <span className="sound-tile__label">{item.displayName}</span>
                          {configured && <span className="sound-tile__badge" aria-hidden="true">♪</span>}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </section>
          );
        })}
      </div>

      <aside className="items-catalog__inspector" aria-label="Информация о предмете">
        {!selectedItem ? (
          <p className="heroes-grid__empty">Выберите предмет слева.</p>
        ) : (
          <>
            <h3 className="items-catalog__inspector-title">Информация</h3>
            <div className="items-catalog__inspector-item">
              <img className="items-catalog__inspector-icon" src={selectedItem.iconUrl} alt="" width={64} height={48} />
              <div>
                <strong>{selectedItem.displayName}</strong>
                <div className="items-catalog__inspector-category">
                  <Badge tone="gold">{ITEM_CATEGORY_LABEL[categoryOf(selectedItem.id)]}</Badge>
                </div>
              </div>
            </div>

            {selectedItem.supported ? (
              <SoundBindingRow
                eventId={selectedItem.id}
                kind="itemUsed"
                masterVolume={settings.masterVolume}
                binding={binding}
                assets={settings.assets}
                onChooseFile={onChooseFile}
                onPreview={onPreview}
                onRemove={onRemove}
              />
            ) : (
              <p className="items-catalog__unsupported">
                Автоматическое событие пока не поддерживается{selectedItem.reason ? `: ${selectedItem.reason}` : "."}
              </p>
            )}
          </>
        )}
      </aside>
    </div>
  );
}
