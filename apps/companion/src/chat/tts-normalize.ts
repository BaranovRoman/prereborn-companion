// Speech-only text normalization, layered on top of WK-66's prepareTtsText
// filters in chat-model.ts. Nothing here ever touches what's shown in the
// chat UI (message.text/message.author render straight from the raw
// TwitchChatMessage in TwitchChatPage.tsx) - these functions only shape the
// separate string handed to the TTS engine.
//
// Deliberately not a general transliteration/NLP system: only Latin
// username fragments get transliterated (WK-77 follow-up - Piper's ru_RU
// voice, via espeak-ng's "ru" phonemizer, mangles raw Latin text: e.g.
// "romaromych" comes out sounding like "омаомыч", dropped leading /r/ and
// all; "imwisp" like "имисп", dropped /w/ entirely - Cyrillic text through
// the same voice is unaffected). Ordinary Cyrillic usernames and message
// text are never touched by this - only Latin letters inside a username
// get rewritten into a Cyrillic phonetic approximation before reaching
// Piper. Not academically correct transliteration, just a predictable
// Twitch-nickname heuristic good enough to read as a name.

const VOWELS = /[aeiouyаеёиоуыэюя]/i;

// Trailing platform-suffix tokens that add nothing when spoken (case-
// insensitive, matched as a whole token after splitting on separators, e.g.
// "Roma_Romych_TV").
const NOISE_SUFFIXES = new Set(["tv", "ttv"]);

// Same suffix, but glued directly onto a name with no separator (e.g.
// "StreamerTTV", "xQcTTV") - strip it only when a sufficiently long name
// remains, so this can't eat a short unrelated word that happens to end in
// "tv".
const GLUED_STREAM_SUFFIX = /(ttv|tv)$/i;
const stripGluedStreamSuffix = (token: string): string => {
  if (NOISE_SUFFIXES.has(token.toLowerCase())) return token; // handled by the whole-token filter below
  const match = token.match(GLUED_STREAM_SUFFIX);
  if (!match) return token;
  const remainder = token.slice(0, token.length - match[0].length);
  return remainder.length >= 2 ? remainder : token;
};

const collapseRepeatedChars = (token: string) => token.replace(/(.)\1{2,}/gu, "$1$1");

// Longest-match-first digraphs, then a single-letter fallback covering
// every Latin consonant/vowel so any Latin run transliterates in full.
// "w" deliberately maps the same as "v" ("soft" w) - Russian has no native
// /w/ phoneme and espeak-ng's ru voice was dropping it outright rather
// than approximating it, which is exactly what made "imwisp" lose its w.
const LATIN_DIGRAPHS: [string, string][] = [
  ["shch", "щ"],
  ["sh", "ш"],
  ["ch", "ч"],
  ["zh", "ж"],
  ["kh", "х"],
  ["ts", "ц"],
  ["ya", "я"],
  ["yu", "ю"],
  ["yo", "ё"],
];
const LATIN_LETTERS: Record<string, string> = {
  a: "а", b: "б", c: "к", d: "д", e: "е", f: "ф", g: "г", h: "х", i: "и",
  j: "дж", k: "к", l: "л", m: "м", n: "н", o: "о", p: "п", q: "к", r: "р",
  s: "с", t: "т", u: "у", v: "в", w: "в", x: "кс", y: "ы", z: "з",
};

const transliterateLatinRun = (run: string): string => {
  const lower = run.toLowerCase();
  let out = "";
  for (let i = 0; i < lower.length; ) {
    const digraph = LATIN_DIGRAPHS.find(([latin]) => lower.startsWith(latin, i));
    if (digraph) {
      out += digraph[1];
      i += digraph[0].length;
      continue;
    }
    out += LATIN_LETTERS[lower[i]] ?? lower[i];
    i += 1;
  }
  // Capitalize the result the same way the original run was capitalized -
  // speech doesn't care about case, but it keeps a name looking like a
  // name rather than forcing a casing opinion on it.
  return /^[A-Z]/.test(run) ? out.charAt(0).toUpperCase() + out.slice(1) : out;
};

// Only Latin letter runs are rewritten - digits and any Cyrillic already
// present in the same token pass through untouched, so a token that
// happens to mix scripts (rare, but possible with no separator) doesn't
// get its Cyrillic half mangled.
const transliterateLatinToCyrillic = (token: string): string =>
  token.replace(/[a-zA-Z]+/g, transliterateLatinRun);

// A token with no vowels at all and no digits is very likely a hash/id
// fragment (e.g. "xk39fj2" minus digits -> "xkfj", "qzxpr") rather than a
// pronounceable name fragment - drop it from speech rather than have Piper
// spell out consonant soup letter by letter.
const isUnreadableFragment = (token: string) =>
  token.length >= 6 && !VOWELS.test(token) && !/\d/.test(token);

// A long run of digits (6+) reads as a wall of individual numbers, not a
// name - typical of trailing IDs (e.g. "xqc_48210394"). Short digit runs
// (year, level, lucky number) stay - those are commonly part of how people
// actually read a handle out loud.
const isLongDigitRun = (token: string) => /^\d{6,}$/.test(token);

const MAX_SPOKEN_USERNAME_LENGTH = 40;

export const normalizeUsernameForSpeech = (username: string): string => {
  const withDigitBoundaries = username.replace(/([a-zA-Zа-яА-ЯёЁ])(\d)/gu, "$1 $2").replace(/(\d)([a-zA-Zа-яА-ЯёЁ])/gu, "$1 $2");
  const tokens = withDigitBoundaries
    .split(/[_\-.\s]+/)
    .filter(Boolean)
    .map(stripGluedStreamSuffix)
    .filter((token) => !NOISE_SUFFIXES.has(token.toLowerCase()))
    .filter((token) => !isUnreadableFragment(token))
    .filter((token) => !isLongDigitRun(token))
    .map(collapseRepeatedChars)
    .map(transliterateLatinToCyrillic);

  const normalized = tokens.join(" ").trim();
  // Never go fully silent on a name - if normalization stripped everything
  // (e.g. a username that's entirely a platform suffix or pure noise),
  // fall back to the original rather than skipping the name. Still run the
  // fallback through transliteration - a raw Latin fallback would hit the
  // exact espeak-ng mangling this function exists to avoid.
  const result = normalized || transliterateLatinToCyrillic(username);
  return result.length > MAX_SPOKEN_USERNAME_LENGTH
    ? result.slice(0, MAX_SPOKEN_USERNAME_LENGTH).trim()
    : result;
};

// User-supplied pronunciation overrides, one per line: "username=spoken
// name". Stored as a single raw string in ChatSettings.usernamePronunciations
// (see chat-model.ts) rather than a structured list/editor UI - "a simple
// list", not a dictionary manager. Twitch usernames are case-insensitive as
// an identity, so lookups are case-insensitive on the username side.
export const parsePronunciationOverrides = (raw: string): Record<string, string> => {
  const overrides: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) continue;
    const username = line.slice(0, separatorIndex).trim().toLowerCase();
    const spoken = line.slice(separatorIndex + 1).trim();
    if (username && spoken) overrides[username] = spoken;
  }
  return overrides;
};

// An override always wins over automatic transliteration/cleanup - it's an
// explicit human correction, not another heuristic to blend in.
export const resolveSpokenUsername = (username: string, overrides: Record<string, string>): string =>
  overrides[username.trim().toLowerCase()] ?? normalizeUsernameForSpeech(username);

// Matches runs of "ха"/"ах"/"хи" syllables (3+ repeats, the shape of
// Cyrillic laughter) and Latin "ha"/"he" laughter, case-insensitively.
// Deliberately does NOT match "гг"/"ггг" ("good game") - a distinct Dota
// chat convention, not laughter.
const LAUGHTER_PATTERN = /(?:ха|ах|хи|hah?a?|he)(?:[\s,]*(?:ха|ах|хи|hah?a?|he)){2,}/giu;
// Any run of 2+ punctuation marks from this set: a uniform run ("!!!",
// "...") collapses to one mark, a mixed run ("?!?!", "!?!") collapses to
// its first two marks so a genuine "?!" survives.
const EXCESSIVE_PUNCTUATION = /[!?.,]{2,}/gu;
// Emoji + pictographs + variation selectors/ZWJ - stripped rather than
// spoken, per the "skip, don't build a description system" scope.
const EMOJI_PATTERN = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}️‍]/gu;

export const normalizeMessageForSpeech = (text: string): string =>
  text
    .replace(EMOJI_PATTERN, " ")
    .replace(LAUGHTER_PATTERN, "ха-ха")
    .replace(EXCESSIVE_PUNCTUATION, (run) => (/^(.)\1*$/.test(run) ? run[0] : run.slice(0, 2)))
    .replace(/(.)\1{2,}/gu, "$1$1")
    .replace(/\s+/g, " ")
    .trim();
