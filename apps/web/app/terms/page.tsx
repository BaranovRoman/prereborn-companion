import type { Metadata } from "next";
import { TermsPage } from "@/components/pages/terms";
import { isLegalDocumentPublished, LEGAL_OPERATOR } from "@/shared/config/legal";

const title = "Пользовательское соглашение";
const description = "Условия использования Prereborn Companion: сайта, приложения Companion и Twitch-расширения.";

// WK-191 - published together with /privacy; both stay out of search until
// their effective (publication) date is set in shared/config/legal.ts.
const published = isLegalDocumentPublished(LEGAL_OPERATOR);

export const metadata: Metadata = {
  title,
  description,
  alternates: { canonical: "/terms" },
  robots: published ? undefined : { index: false, follow: false },
  openGraph: { title: `${title} — Prereborn Companion`, description, url: "/terms", type: "website", siteName: "Prereborn Companion", locale: "ru_RU" },
};

export default function Terms() {
  return <TermsPage />;
}
