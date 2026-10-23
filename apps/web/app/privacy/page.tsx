import type { Metadata } from "next";
import { PrivacyPage } from "@/components/pages/privacy";
import { isLegalDocumentPublished, LEGAL_OPERATOR } from "@/shared/config/legal";

const title = "Политика обработки персональных данных";
const description = "Какие персональные данные обрабатывает Prereborn Companion, зачем, где и сколько хранит и как ими управлять.";

// WK-191 - stays out of search until the effective (publication) date is set in
// shared/config/legal.ts, so a draft never gets indexed as the policy.
const complete = isLegalDocumentPublished(LEGAL_OPERATOR);

export const metadata: Metadata = {
  title,
  description,
  alternates: { canonical: "/privacy" },
  robots: complete ? undefined : { index: false, follow: false },
  openGraph: { title: `${title} — Prereborn Companion`, description, url: "/privacy", type: "website", siteName: "Prereborn Companion", locale: "ru_RU" },
};

export default function Privacy() {
  return <PrivacyPage />;
}
