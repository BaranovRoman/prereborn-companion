"use client";

import { useState } from "react";
import type { ChangelogItem, ChangelogProduct } from "@/entities/changelog/load";
import { ChangelogCard } from "./ChangelogCard";
import styles from "./changelog.module.scss";

const ALL = "all";

/** One feed for Companion and every plugin, filterable by product. */
export const ChangelogFeed = ({ items, products }: { items: ChangelogItem[]; products: ChangelogProduct[] }) => {
  const [filter, setFilter] = useState(ALL);
  const visible = filter === ALL ? items : items.filter((item) => item.product.id === filter);
  const options = [{ id: ALL, label: "Все" }, ...products.map((product) => ({ id: product.id, label: product.kind === "companion" ? "Companion" : product.name }))];
  return (
    <>
      {products.length > 1 ? (
        <div className={styles.filters} role="group" aria-label="Продукт">
          {options.map((option) => (
            <button key={option.id} type="button" aria-pressed={filter === option.id} onClick={() => setFilter(option.id)}>{option.label}</button>
          ))}
        </div>
      ) : null}
      <div className={styles.feed}>
        {visible.map((item) => <ChangelogCard key={`${item.product.id}@${item.version}`} item={item} />)}
      </div>
    </>
  );
};
