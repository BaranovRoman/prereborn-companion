import type { Metadata } from "next";
import { ChangelogPage } from "@/components/pages/changelog";
import { loadChangelogFeed } from "@/entities/changelog/load";
import { loadPluginCatalog } from "@/entities/plugin-catalog";

export const revalidate = 600;

const description = "Что нового в Prereborn Companion и игровых плагинах: новые возможности, улучшения и исправления по версиям.";

export const metadata: Metadata = {
  title: "История обновлений",
  description,
  alternates: { canonical: "/changelog" },
  openGraph: { title: "История обновлений — Prereborn Companion", description, url: "/changelog", type: "website", siteName: "Prereborn Companion", locale: "ru_RU" },
};

export default async function Changelog() {
  const catalog = await loadPluginCatalog();
  return <ChangelogPage feed={await loadChangelogFeed(catalog.ok ? catalog.plugins : null)} />;
}
