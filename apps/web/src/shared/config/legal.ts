// WK-191 - legally significant details of the personal-data operator shown on
// /privacy. Every field stays null until the owner confirms it: the page then
// renders an explicit "not filled in" marker, a draft banner and noindex
// instead of a guessed value (see docs/research/personal-data-audit.md).
export interface PrivacyOperatorDetails {
  /** Full name of the operator (an individual, the project owner). */
  operatorName: string | null;
  /**
   * Optional postal address for written requests. Not required in the policy by
   * ст. 18.1 152-ФЗ; the owner decided not to publish a home address, so it is
   * shown only when set and does not block publication.
   */
  postalAddress: string | null;
  /** Email that receives data-subject requests. */
  contactEmail: string | null;
  /** Policy effective date, ISO YYYY-MM-DD. */
  effectiveDate: string | null;
  /**
   * How long nginx access logs (IP, User-Agent) live on the server. Fill in only a
   * term that is actually configured and verified (see the readiness doc).
   */
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

const REQUIRED_DETAILS = ["operatorName", "contactEmail", "effectiveDate", "serverLogRetention"] as const;

export const isPrivacyPolicyComplete = (details: PrivacyOperatorDetails): boolean =>
  REQUIRED_DETAILS.every((key) => {
    const value = details[key];
    return typeof value === "string" && value.trim().length > 0;
  });
