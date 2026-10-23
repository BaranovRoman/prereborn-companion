// WK-191 - the user agreement version an account has to accept. It is the
// agreement's effective date (YYYY-MM-DD) and MUST equal
// LEGAL_OPERATOR.effectiveDate in apps/web/src/shared/config/legal.ts (a web
// test compares the two). null until the agreement is published: nobody is
// asked to accept a draft. Set it in the publication commit; a later edition
// gets a new date, and every account is asked to accept it again.
export const termsConfig: { currentVersion: string | null } = {
    currentVersion: null,
};
