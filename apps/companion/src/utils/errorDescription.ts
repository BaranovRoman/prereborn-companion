// WK-63 - shared shape for the small per-domain error-copy mappers
// (gsiErrorCopy/obsErrorCopy/authErrorCopy): a short human title+message for
// the primary UI, plus the original raw string preserved as `detail` for
// Diagnostics/troubleshooting. Never drop `detail` when a raw string exists -
// see the ticket's "preserve diagnostic information" rule.
export interface ErrorDescription {
  title: string;
  message: string;
  detail: string | null;
}
