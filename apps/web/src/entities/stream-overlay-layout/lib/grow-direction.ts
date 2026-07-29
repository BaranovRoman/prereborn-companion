import type { OverlayAnchor } from "../model/types";
import { splitAnchor } from "./anchor";

export type ListGrowDirection = "down" | "up";

// growDirection больше не хранится в layout (см. задачу, п.3) - вычисляется
// из Y-части anchor'а виджета: top-* растёт вниз (верхний край неподвижен),
// bottom-* растёт вверх (нижний край неподвижен). Для center-* нет
// естественного "неподвижного" края - вниз выбран как самый предсказуемый
// вариант (тот же, что top-*), а не потому что у center есть какая-то
// структурная причина расти именно так.
export const growDirectionForAnchor = (anchor: OverlayAnchor): ListGrowDirection => {
    const { y } = splitAnchor(anchor);
    return y === "bottom" ? "up" : "down";
};
