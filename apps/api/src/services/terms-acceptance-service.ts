import { pool } from "../db/client.js";
import { termsConfig } from "../config/legal.js";

// WK-191 - explicit acceptance of the user agreement. New accounts accept it
// with the registration button (the form sends the version it showed);
// accounts created before publication - or before a new edition - accept it
// on the site or in Companion. Nothing is blocked while it isn't accepted:
// signing out and deleting the account must keep working.

export interface TermsStatus {
    /** The edition in force, null while the agreement is unpublished. */
    currentVersion: string | null;
    acceptedVersion: string | null;
    acceptedAt: string | null;
    acceptanceRequired: boolean;
}

export const getTermsStatus = async (streamUserId: string): Promise<TermsStatus | null> => {
    const result = await pool.query<{ terms_accepted_version: string | null; terms_accepted_at: Date | null }>(
        "SELECT terms_accepted_version, terms_accepted_at FROM stream_users WHERE id = $1",
        [streamUserId]
    );
    const row = result.rows[0];
    if (!row) return null;
    const currentVersion = termsConfig.currentVersion;
    return {
        currentVersion,
        acceptedVersion: row.terms_accepted_version,
        acceptedAt: row.terms_accepted_at ? row.terms_accepted_at.toISOString() : null,
        acceptanceRequired: currentVersion !== null && row.terms_accepted_version !== currentVersion,
    };
};

export type AcceptTermsResult = "accepted" | "stale_version" | "not_found";

// Records acceptance only of the edition in force: a client that showed an
// older (or unpublished) text gets "stale_version" and must reload it.
// Accepting the same edition again keeps the first acceptance time.
export const acceptTerms = async (streamUserId: string, version: string): Promise<AcceptTermsResult> => {
    if (termsConfig.currentVersion === null || version !== termsConfig.currentVersion) return "stale_version";
    const result = await pool.query(
        `UPDATE stream_users
         SET terms_accepted_at = CASE WHEN terms_accepted_version = $2 THEN terms_accepted_at ELSE NOW() END,
             terms_accepted_version = $2
         WHERE id = $1`,
        [streamUserId, version]
    );
    return result.rowCount ? "accepted" : "not_found";
};
