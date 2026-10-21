// Pronunciation dictionary for TTS (WK-184): "say X as Y", applied to the
// speech-only copy of a chat message before normalizeMessageForSpeech. The
// chat UI keeps rendering the original TwitchChatMessage untouched.
//
// Priority at any position in the text: a rule scoped to the message's
// author, then the user's global rules, then the built-in ones. Within a
// level the longer source wins. Everything happens in ONE left-to-right pass
// over the original text, and replaced text is never scanned again - so no
// rule can feed another (no cycles, no cascades), and output growth is
// capped separately below.

export type PronunciationScope =
  | { kind: "global" }
  // `userId` is Twitch's stable chatter_user_id when it was known at save
  // time (picked from a recent chatter); `login` is the fallback identity and
  // what the settings list shows.
  | { kind: "user"; login: string; userId: string | null };

export interface PronunciationRule {
  id: string;
  source: string;
  spoken: string;
  enabled: boolean;
  scope: PronunciationScope;
}

export interface SpeechAuthor { id: string | null; login: string | null; name: string }

// Chat shorthand Silero otherwise reads as a consonant cluster ("хз" comes
// out as a short hiss). Whole words only, any case.
export const BUILT_IN_PRONUNCIATIONS: readonly { source: string; spoken: string }[] = [
  { source: "хз", spoken: "хэзэ" },
  { source: "тб", spoken: "тэбэ" },
];

export const MAX_PRONUNCIATION_RULES = 300;
export const MAX_SOURCE_LENGTH = 60;
export const MAX_SPOKEN_LENGTH = 120;
// Total characters replacements may add to one message. Past it, the rest of
// the message is read as written rather than growing without bound.
const MAX_GROWTH = 500;

const ruleKey = (text: string) => text.trim().replace(/\s+/g, " ").toLowerCase();
const loginKey = (login: string) => login.trim().replace(/^@/, "").toLowerCase();

const isScope = (value: unknown): value is PronunciationScope => {
  if (!value || typeof value !== "object") return false;
  const scope = value as Record<string, unknown>;
  if (scope.kind === "global") return true;
  return scope.kind === "user" && typeof scope.login === "string" && !!loginKey(scope.login)
    && (scope.userId === null || scope.userId === undefined || typeof scope.userId === "string");
};

// Persisted rules come from localStorage - anything malformed, oversized or
// beyond the count limit is dropped instead of breaking speech.
export const normalizePronunciationRules = (raw: unknown): PronunciationRule[] => {
  if (!Array.isArray(raw)) return [];
  const rules: PronunciationRule[] = [];
  for (const item of raw) {
    if (rules.length >= MAX_PRONUNCIATION_RULES) break;
    if (!item || typeof item !== "object") continue;
    const rule = item as Record<string, unknown>;
    if (typeof rule.id !== "string" || typeof rule.source !== "string" || typeof rule.spoken !== "string" || !isScope(rule.scope)) continue;
    if (validateText(rule.source, rule.spoken)) continue;
    const scope: PronunciationScope = rule.scope.kind === "global"
      ? { kind: "global" }
      : { kind: "user", login: loginKey(rule.scope.login), userId: rule.scope.userId || null };
    rules.push({ id: rule.id, source: rule.source.trim(), spoken: rule.spoken.trim(), enabled: rule.enabled !== false, scope });
  }
  return rules;
};

const validateText = (source: string, spoken: string): string | null => {
  const from = source.trim();
  if (!from) return "Укажите исходный текст.";
  if (!/[\p{L}\p{N}]/u.test(from)) return "Исходный текст должен содержать буквы или цифры.";
  if (from.length > MAX_SOURCE_LENGTH) return `Исходный текст — не длиннее ${MAX_SOURCE_LENGTH} символов.`;
  if (!spoken.trim()) return "Укажите, как произносить.";
  if (spoken.trim().length > MAX_SPOKEN_LENGTH) return `Произношение — не длиннее ${MAX_SPOKEN_LENGTH} символов.`;
  return null;
};

const sameScope = (a: PronunciationScope, b: PronunciationScope) => {
  if (a.kind === "global" || b.kind === "global") return a.kind === b.kind;
  if (a.userId && b.userId) return a.userId === b.userId;
  return loginKey(a.login) === loginKey(b.login);
};

// Returns a user-facing reason the draft can't be saved, or null. One rule
// per source text and scope: two rules for the same thing would only make the
// result depend on list order.
export const validatePronunciationRule = (
  draft: Omit<PronunciationRule, "id" | "enabled">,
  rules: readonly PronunciationRule[],
  editingId?: string,
): string | null => {
  const textError = validateText(draft.source, draft.spoken);
  if (textError) return textError;
  if (draft.scope.kind === "user" && !loginKey(draft.scope.login)) return "Укажите ник зрителя.";
  const others = rules.filter((rule) => rule.id !== editingId);
  if (!editingId && others.length >= MAX_PRONUNCIATION_RULES) return `Не больше ${MAX_PRONUNCIATION_RULES} правил.`;
  const key = ruleKey(draft.source);
  if (others.some((rule) => ruleKey(rule.source) === key && sameScope(rule.scope, draft.scope))) {
    return draft.scope.kind === "global" ? `Общее правило для «${draft.source.trim()}» уже есть.` : `Правило для «${draft.source.trim()}» у этого зрителя уже есть.`;
  }
  return null;
};

const appliesTo = (scope: PronunciationScope, author: SpeechAuthor | undefined) => {
  if (scope.kind === "global") return true;
  if (!author) return false;
  // The stable id decides whenever both sides have one: a renamed viewer
  // keeps their rule, and someone who later takes the old login doesn't get it.
  if (scope.userId && author.id) return scope.userId === author.id;
  return loginKey(scope.login) === loginKey(author.login ?? author.name);
};

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const byLengthDesc = (a: { source: string }, b: { source: string }) => ruleKey(b.source).length - ruleKey(a.source).length;

export const applyPronunciations = (
  text: string,
  rules: readonly PronunciationRule[],
  author?: SpeechAuthor,
): string => {
  const active = rules.filter((rule) => rule.enabled);
  const levels = [
    active.filter((rule) => rule.scope.kind === "user" && appliesTo(rule.scope, author)),
    active.filter((rule) => rule.scope.kind === "global"),
    BUILT_IN_PRONUNCIATIONS,
  ];
  // First (highest-priority) entry per source wins; regex alternatives keep
  // the same order, so at a given position the regex tries them that way too.
  const spokenByKey = new Map<string, string>();
  const alternatives: string[] = [];
  for (const level of levels) {
    for (const rule of [...level].sort(byLengthDesc)) {
      const key = ruleKey(rule.source);
      if (!key || spokenByKey.has(key)) continue;
      spokenByKey.set(key, rule.spoken.trim());
      alternatives.push(key.split(" ").map(escapeRegExp).join("\\s+"));
    }
  }
  if (!alternatives.length) return text;
  // Whole words only: "тб" must not fire inside "тбилиси".
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${alternatives.join("|")})(?![\\p{L}\\p{N}_])`, "giu");
  let growth = 0;
  return text.replace(pattern, (match) => {
    const spoken = spokenByKey.get(ruleKey(match));
    if (spoken === undefined) return match;
    if (growth + spoken.length - match.length > MAX_GROWTH) return match;
    growth += spoken.length - match.length;
    return spoken;
  });
};

export const newPronunciationRuleId = () =>
  globalThis.crypto?.randomUUID?.() ?? `rule-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
