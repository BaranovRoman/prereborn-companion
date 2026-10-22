// WK-191 - legally significant details of the personal-data operator shown on
// /privacy. Every field stays null until the owner confirms it: the page then
// renders an explicit "not filled in" marker, a draft banner and noindex
// instead of a guessed value (see docs/research/personal-data-audit.md).
export interface PrivacyOperatorDetails {
  /** Full name of the operator (an individual, the project owner). */
  operatorName: string | null;
  /** Postal address for written requests (ч. 3 ст. 14 152-ФЗ). */
  postalAddress: string | null;
  /** Email that receives data-subject requests. */
  contactEmail: string | null;
  /** Policy effective date, ISO YYYY-MM-DD. */
  effectiveDate: string | null;
  /** How long nginx access logs (IP, User-Agent) live on the server, e.g. "30 дней". */
  serverLogRetention: string | null;
}

export const PRIVACY_OPERATOR: PrivacyOperatorDetails = {
  operatorName: null,
  postalAddress: null,
  contactEmail: null,
  effectiveDate: null,
  serverLogRetention: null,
};

export const PRIVACY_PATH = "/privacy";

export const isPrivacyPolicyComplete = (details: PrivacyOperatorDetails): boolean =>
  Object.values(details).every((value) => typeof value === "string" && value.trim().length > 0);
