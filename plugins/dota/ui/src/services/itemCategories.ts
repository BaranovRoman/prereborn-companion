// Item grouping for the package "Предметы" catalog. The category comes from
// the generated catalog itself (scripts/generate-game-sounds-item-catalog.mjs:
// consumable / component / secret shop / Valve quality / neutral tier), so a
// new patch never needs a hand-maintained shop-tab map here.
import type { TrackedItem } from "./dotaCompanionApi";

export type ItemCategoryGroup = "basics" | "upgrades" | "neutral";
export type ItemCategory =
  | "consumables" | "components" | "secretShop"
  | "common" | "rare" | "epic" | "artifact"
  | "neutral1" | "neutral2" | "neutral3" | "neutral4" | "neutral5";

export const ITEM_CATEGORY_GROUP_LABEL: Record<ItemCategoryGroup, string> = {
  basics: "Основные",
  upgrades: "Улучшения",
  neutral: "Нейтральные",
};

export const ITEM_CATEGORY_LABEL: Record<ItemCategory, string> = {
  consumables: "Расходники", components: "Компоненты", secretShop: "Потайная лавка",
  common: "Обычные", rare: "Редкие", epic: "Эпические", artifact: "Артефакты",
  neutral1: "Тир 1", neutral2: "Тир 2", neutral3: "Тир 3", neutral4: "Тир 4", neutral5: "Тир 5",
};

export const ITEM_CATEGORY_GROUP: Record<ItemCategory, ItemCategoryGroup> = {
  consumables: "basics", components: "basics", secretShop: "basics",
  common: "upgrades", rare: "upgrades", epic: "upgrades", artifact: "upgrades",
  neutral1: "neutral", neutral2: "neutral", neutral3: "neutral", neutral4: "neutral", neutral5: "neutral",
};

export const ITEM_CATEGORY_ORDER: ItemCategory[] = [
  "consumables", "components", "secretShop", "common", "rare", "epic", "artifact",
  "neutral1", "neutral2", "neutral3", "neutral4", "neutral5",
];

export function categoryOf(item: Pick<TrackedItem, "category">): ItemCategory {
  return (ITEM_CATEGORY_ORDER as string[]).includes(item.category) ? item.category as ItemCategory : "components";
}
