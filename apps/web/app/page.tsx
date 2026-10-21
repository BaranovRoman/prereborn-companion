import type { Metadata } from "next";
import { LandingPage } from "@/components/pages/landing";
import { loadChangelogFeed, pickHighlight } from "@/entities/changelog/load";
import { loadPluginCatalog } from "@/entities/plugin-catalog";

// WK-188 - plugins and the latest update are read from the published catalog
// and changelog (refreshed every 10 minutes); the version and installer come
// from the build (see PublicShell's companionDownloadHref).
export const revalidate = 600;

const title = "Prereborn Companion — приложение для стримеров";
const description =
  "Twitch-чат с озвучкой, словарь произношений, клипы по горячей клавише, подключение к OBS и игровые плагины. Desktop-приложение для Windows.";

export const metadata: Metadata = {
  title: { absolute: title },
  description,
  alternates: { canonical: "/" },
  openGraph: { title, description, url: "/", type: "website", siteName: "Prereborn Companion", locale: "ru_RU" },
};

export default async function HomePage() {
  const catalog = await loadPluginCatalog();
  const feed = await loadChangelogFeed(catalog.ok ? catalog.plugins : null);
  return <LandingPage catalog={catalog} highlight={pickHighlight(feed.items)} />;
}
