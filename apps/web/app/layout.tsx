import type { Metadata, Viewport } from "next";
import { AntdRegistry } from "@ant-design/nextjs-registry";
import { AppAtmosphere } from "@/shared/ui/app-atmosphere";
import "./globals.css";

// WK-188 - site-wide defaults: Companion is the product, games are plugins.
// The Open Graph image is app/opengraph-image.png (Telegram/VK link previews).
const siteDescription =
  "Desktop-приложение для стримеров на Windows: Twitch-чат с озвучкой, клипы по горячей клавише, подключение к OBS и игровые плагины.";

export const metadata: Metadata = {
  title: {
    default: "Prereborn Companion",
    template: "%s — Prereborn Companion"
  },
  applicationName: "Prereborn Companion",
  description: siteDescription,
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000"),
  robots: { index: true, follow: true },
  openGraph: {
    siteName: "Prereborn Companion",
    locale: "ru_RU",
    type: "website",
    title: "Prereborn Companion",
    description: siteDescription
  },
  twitter: { card: "summary_large_image" }
};

export const viewport: Viewport = { themeColor: "#0f1013", colorScheme: "dark" };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ru">
      <body>
        <AntdRegistry>
          <AppAtmosphere />
          <div className="appContent">{children}</div>
        </AntdRegistry>
      </body>
    </html>
  );
}
