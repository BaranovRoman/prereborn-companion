// WK-191 - operator details shown on /privacy and /terms. Only details the
// owner confirmed are filled in; a home address, passport data or tax ids are
// never published here (docs/legal/wk-191-publication-readiness.md, section 1).
export interface LegalOperatorDetails {
  /** Full name of the operator (an individual, the project owner). */
  operatorName: string | null;
  /** Email that receives data-subject requests and questions about the terms. */
  contactEmail: string | null;
  /**
   * Optional postal address for written requests. Not required in the policy by
   * ст. 18.1 152-ФЗ and not published by the owner's decision: shown only when set.
   */
  postalAddress: string | null;
  /**
   * Date both documents take effect, ISO YYYY-MM-DD. It is the actual publication
   * date: set it in the commit that is merged and deployed to publish them. Until
   * then both pages are marked as a draft and kept out of search.
   */
  effectiveDate: string | null;
}

export const LEGAL_OPERATOR: LegalOperatorDetails = {
  operatorName: "Баранов Роман Валерьевич",
  contactEmail: "baranov.react@gmail.com",
  postalAddress: null,
  effectiveDate: null,
};

export const PRIVACY_PATH = "/privacy";
export const TERMS_PATH = "/terms";

const REQUIRED_DETAILS = ["operatorName", "contactEmail", "effectiveDate"] as const;

export const isLegalDocumentPublished = (details: LegalOperatorDetails): boolean =>
  REQUIRED_DETAILS.every((key) => {
    const value = details[key];
    return typeof value === "string" && value.trim().length > 0;
  });

export const formatLegalDate = (iso: string | null): string | null => {
  if (!iso) return null;
  const date = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
};
