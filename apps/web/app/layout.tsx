import type { Metadata } from "next";
import { AntdRegistry } from "@ant-design/nextjs-registry";
import { AppAtmosphere } from "@/shared/ui/app-atmosphere";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "PreReborn Companion",
    template: "%s — PreReborn Companion"
  },
  applicationName: "PreReborn Companion",
  description: "Dota 2 streamer companion, OBS overlay и anti-stream-snipe.",
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000"),
  robots: { index: true, follow: true }
};

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
