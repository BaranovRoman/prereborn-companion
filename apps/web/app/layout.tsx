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
  description: "Dota streamer companion and OBS overlays",
  robots: { index: false, follow: false }
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <AntdRegistry>
          <AppAtmosphere />
          <div className="appContent">{children}</div>
        </AntdRegistry>
      </body>
    </html>
  );
}
