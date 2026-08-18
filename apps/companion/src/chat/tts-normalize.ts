// Speech-only text normalization, layered on top of WK-66's prepareTtsText
// filters in chat-model.ts. Nothing here ever touches what's shown in the
// chat UI (message.text/message.author render straight from the raw
// TwitchChatMessage in TwitchChatPage.tsx) - these functions only shape the
// separate string handed to the TTS engine.
//
// Deliberately not a general transliteration/NLP system: usernames keep
// their original script (Cyrillic stays Cyrillic, Latin stays Latin) and
// only get light structural cleanup - separators become spaces, common
// platform suffixes are dropped, obvious noise is trimmed. Good enough for
// "sounds like a name, not a raw identifier" - not phonetic perfection.

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
    .map(collapseRepeatedChars);

  const normalized = tokens.join(" ").trim();
  // Never go fully silent on a name - if normalization stripped everything
  // (e.g. a username that's entirely a platform suffix or pure noise),
  // fall back to the original rather than skipping the name.
  const result = normalized || username;
  return result.length > MAX_SPOKEN_USERNAME_LENGTH
    ? result.slice(0, MAX_SPOKEN_USERNAME_LENGTH).trim()
    : result;
};

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
