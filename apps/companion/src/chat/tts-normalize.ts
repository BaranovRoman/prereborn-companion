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
//
// `login` (Twitch's stable chatter_user_login, e.g. "romaromych" - the
// handle from the channel URL) is checked before `username` (the cosmetic
// chatter_user_name/display name shown in chat, e.g. "RomaRomych_TV" or a
// since-renamed display name). A streamer configuring an override naturally
// types the login they know the viewer by, not whatever display name that
// viewer's chat client happens to render this message with - matching only
// `username` silently misses every viewer whose display name isn't a plain
// case-variant of their login. Both sides of the comparison are
// trimmed/lowercased, same as the username side.
export const resolveSpokenUsername = (
  username: string,
  overrides: Record<string, string>,
  login?: string | null,
): string =>
  (login ? overrides[login.trim().toLowerCase()] : undefined) ??
  overrides[username.trim().toLowerCase()] ??
  normalizeUsernameForSpeech(username);

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

// WK-82 - message-body counterpart to the username handling above, but for
// a completely different reason than "espeak-ng phonemizes Latin badly"
// (WK-77's motivation). Confirmed directly against the real shipped model
// (torch.package-loaded v5_5_ru, apply_tts run for real, not guessed):
// Silero's own PartTTSModelMultiAcc_v3.prepare_text_input() runs a hard
// character whitelist - `self.symbols` is Cyrillic letters + punctuation +
// space ONLY - before any phonemization happens, and silently *deletes*
// every digit and every Latin letter in the input, unconditionally,
// regardless of spacing or context. "RTX 5060 Ti норм" reaches Silero as
// "норм"; "HTTP 500"/"Windows 11"/"FPS 144" reach it as "" (empty), which
// throws inside apply_tts and drops the whole utterance (silently
// triggering the Piper fallback, or a spurious step toward Silero's
// consecutive-failure cooldown, for a perfectly healthy sidecar). This is
// not a phonemization quality problem the way raw Latin usernames were for
// Piper - it's outright character deletion, so "make the pronunciation
// nicer" fixes (spacing, phonetic hints) can't help; every digit and Latin
// letter that must survive has to already be Cyrillic+punctuation by the
// time it reaches the engine. Piper/espeak-ng already speaks plain
// Cyrillic text (including Russian number words) correctly, so the same
// rewritten text works for both engines - no per-engine branching needed.
//
// Only ASCII letter/digit runs match below; Cyrillic text (the overwhelming
// majority of real messages) never matches this pattern and passes through
// completely untouched.
const MIXED_TOKEN = /[A-Za-z0-9]+(?:[-_./:][A-Za-z0-9]+)*/g;

const insertLetterDigitBoundaries = (token: string): string =>
  token.replace(/([A-Za-z])(\d)/g, "$1 $2").replace(/(\d)([A-Za-z])/g, "$1 $2");

// A short, entirely-uppercase run reads as an initialism (RTX, OBS, HTTP,
// WK, GG, FPS) rather than a word - blending it through the same
// digraph/letter transliteration used for ordinary words would produce an
// unpronounceable vowel-less consonant cluster (confirmed directly: Silero
// keeps "RTX" pre-transliterated to "РТХ" as literal "ртх", not something
// resembling the initialism read aloud). Mixed- or lower-case runs
// (Windows, hello, iPhone) are treated as ordinary words instead - this is
// a surface-form heuristic, not semantic acronym detection, so a
// shout-cased ordinary word is a known, accepted edge case.
const MAX_ACRONYM_LENGTH = 6;
const isLatinAcronym = (run: string) => /^[A-Z]+$/.test(run) && run.length <= MAX_ACRONYM_LENGTH;

// Standard "English letter name, transliterated to Russian" table - the
// same convention used whenever Russian speech spells out a Latin
// initialism letter by letter (e.g. "USB" -> "ю-эс-би").
const LATIN_LETTER_NAMES: Record<string, string> = {
  a: "эй", b: "би", c: "си", d: "ди", e: "и", f: "эф", g: "джи", h: "эйч",
  i: "ай", j: "джей", k: "кей", l: "эл", m: "эм", n: "эн", o: "оу", p: "пи",
  q: "кью", r: "ар", s: "эс", t: "ти", u: "ю", v: "ви", w: "дабл-ю",
  x: "икс", y: "уай", z: "зед",
};
const spellOutLatinLetters = (run: string): string =>
  run
    .toLowerCase()
    .split("")
    .map((letter) => LATIN_LETTER_NAMES[letter] ?? letter)
    .join("-");

// Ordinary Latin words/word-fragments reuse the exact same
// digraph/letter transliteration already proven (WK-77) to give Piper's
// espeak-ng phonemizer something it can read - "phonetically odd but
// deterministic and readable, not silently dropped" applies here just as
// much as it does to usernames.
const speakLatinPiece = (run: string): string =>
  isLatinAcronym(run) ? spellOutLatinLetters(run) : transliterateLatinRun(run);

const CARDINAL_ONES = ["", "один", "два", "три", "четыре", "пять", "шесть", "семь", "восемь", "девять"];
const CARDINAL_ONES_FEM = ["", "одна", "две", "три", "четыре", "пять", "шесть", "семь", "восемь", "девять"];
const CARDINAL_TEENS = [
  "десять", "одиннадцать", "двенадцать", "тринадцать", "четырнадцать",
  "пятнадцать", "шестнадцать", "семнадцать", "восемнадцать", "девятнадцать",
];
const CARDINAL_TENS = [
  "", "", "двадцать", "тридцать", "сорок", "пятьдесят", "шестьдесят", "семьдесят", "восемьдесят", "девяносто",
];
const CARDINAL_HUNDREDS = [
  "", "сто", "двести", "триста", "четыреста", "пятьсот", "шестьсот", "семьсот", "восемьсот", "девятьсот",
];
const DIGIT_NAMES = ["ноль", "один", "два", "три", "четыре", "пять", "шесть", "семь", "восемь", "девять"];

// Standard Russian numeral agreement for scale words (тысяча/тысячи/тысяч
// and the million/billion equivalents): singular for values ending in 1
// (except 11), "few" for 2-4 (except 12-14), "many" otherwise.
const pluralFormIndex = (n: number): 0 | 1 | 2 => {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 14) return 2;
  const mod10 = n % 10;
  if (mod10 === 1) return 0;
  if (mod10 >= 2 && mod10 <= 4) return 1;
  return 2;
};

const groupToWords = (n: number, feminine: boolean): string => {
  const words: string[] = [];
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  if (hundreds) words.push(CARDINAL_HUNDREDS[hundreds]);
  if (rest >= 10 && rest < 20) {
    words.push(CARDINAL_TEENS[rest - 10]);
  } else {
    const tens = Math.floor(rest / 10);
    const ones = rest % 10;
    if (tens) words.push(CARDINAL_TENS[tens]);
    if (ones) words.push((feminine ? CARDINAL_ONES_FEM : CARDINAL_ONES)[ones]);
  }
  return words.join(" ");
};

// Thousand is grammatically feminine (одна тысяча, две тысячи); million and
// billion are masculine, same as the bare cardinal.
const SCALES: { forms: [string, string, string]; feminine: boolean }[] = [
  { forms: ["тысяча", "тысячи", "тысяч"], feminine: true },
  { forms: ["миллион", "миллиона", "миллионов"], feminine: false },
  { forms: ["миллиард", "миллиарда", "миллиардов"], feminine: false },
];

// Beyond this many digits there's no scale word left in SCALES to name the
// group correctly (and a run this long in chat is far more likely to be an
// opaque id than a number anyone wants read as a magnitude) - fall back to
// reading one digit at a time rather than guessing.
const MAX_CARDINAL_DIGITS = 12;

// Silero's character whitelist strips every digit outright (see the
// MIXED_TOKEN comment above) - unlike Piper/espeak-ng, which already
// expands numbers on its own, Silero has no number-to-words logic
// anywhere in its pipeline. Spelling the number out here is not optional
// for Silero, and does no harm for Piper (plain Cyrillic number words are
// just more Cyrillic text).
const numberToRussianWords = (raw: string): string => {
  if (raw.length > MAX_CARDINAL_DIGITS) {
    return raw.split("").map((d) => DIGIT_NAMES[Number(d)]).join(" ");
  }
  const n = Number(raw);
  if (n === 0) return "ноль";
  const groups: number[] = [];
  let remaining = n;
  while (remaining > 0) {
    groups.push(remaining % 1000);
    remaining = Math.floor(remaining / 1000);
  }
  const parts: string[] = [];
  for (let i = groups.length - 1; i >= 0; i--) {
    const value = groups[i];
    if (value === 0) continue;
    const scale = i > 0 ? SCALES[i - 1] : undefined;
    const words = groupToWords(value, scale?.feminine ?? false);
    if (words) parts.push(words);
    if (scale) parts.push(scale.forms[pluralFormIndex(value)]);
  }
  return parts.join(" ");
};

// One matched MIXED_TOKEN span (an acronym, a version string, a plain
// number, a glued letter+digit id - "WK-81", "v5_5_ru", "OBS2", "4455")
// gets split at letter/digit boundaries and existing separators alike,
// each piece converted on its own, then rejoined with spaces - the
// original separator characters are discarded rather than preserved,
// since Silero doesn't need them back and Piper doesn't need them either.
const normalizeCodeLikeToken = (token: string): string =>
  insertLetterDigitBoundaries(token)
    .split(/[\s\-_./:]+/)
    .filter(Boolean)
    .map((piece) => (/^\d+$/.test(piece) ? numberToRussianWords(piece) : speakLatinPiece(piece)))
    .join(" ");

export const normalizeMessageForSpeech = (text: string): string =>
  text
    .replace(EMOJI_PATTERN, " ")
    .replace(LAUGHTER_PATTERN, "ха-ха")
    .replace(MIXED_TOKEN, normalizeCodeLikeToken)
    .replace(EXCESSIVE_PUNCTUATION, (run) => (/^(.)\1*$/.test(run) ? run[0] : run.slice(0, 2)))
    .replace(/(.)\1{2,}/gu, "$1$1")
    .replace(/\s+/g, " ")
    .trim();
