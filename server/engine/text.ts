const WINDOW = 480;
const OVERLAP = 90;
const MIN_CHUNK = 40;

export function sha256Hex(input: string | Uint8Array): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(input);
  return hasher.digest("hex");
}

/** Sliding-window chunker ported from rag/build_index.py: 480-char window,
 * 90-char overlap, whitespace collapsed, chunks of <= 40 chars dropped. */
export function chunkText(text: string, window = WINDOW, overlap = OVERLAP): string[] {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= MIN_CHUNK) return [];
  if (collapsed.length <= window) return [collapsed];

  const chunks: string[] = [];
  const step = window - overlap;
  for (let start = 0; start < collapsed.length; start += step) {
    const piece = collapsed.slice(start, start + window);
    if (piece.length > MIN_CHUNK) chunks.push(piece);
    if (start + window >= collapsed.length) break;
  }
  return chunks;
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Turn a free-text user message into a safe FTS5 MATCH expression.
 * Apostrophes split (the unicode61 tokenizer treats them as separators, so a
 * quoted "kernel's" would compile to a strict two-token phrase that never
 * matches). Returns "" when nothing queryable remains. */
export function ftsQuery(message: string): string {
  const tokens = message.toLowerCase().replace(/'/g, " ").match(/[a-z0-9]{3,}/g) ?? [];
  const unique = [...new Set(tokens)].slice(0, 24);
  return unique.map((t) => `"${t}"`).join(" OR ");
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const SEASON_BY_MONTH = [
  "deep winter",   // Jan
  "deep winter",   // Feb
  "early spring",  // Mar
  "spring",        // Apr
  "spring",        // May
  "early summer",  // Jun
  "high summer",   // Jul
  "late summer",   // Aug
  "autumn",        // Sep
  "autumn",        // Oct
  "late autumn",   // Nov
  "deep winter",   // Dec
];

function elapsedPhrase(from: Date, to: Date): string {
  let months =
    (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth());
  if (to.getDate() < from.getDate()) months -= 1;
  if (months < 1) return "a few weeks";
  if (months === 1) return "about a month";
  if (months < 24) return `about ${months} months`;
  const years = Math.round(months / 12);
  return `about ${years} years`;
}

/** The persona's current-date layer: season-aware, and — only when a passing
 * date is known — a flat, undramatic elapsed-time sentence. */
export function seasonLine(now: Date, passingDate?: string): string {
  const base =
    `Today is ${WEEKDAYS[now.getDay()]}, ${MONTHS[now.getMonth()]} ${now.getDate()}, ` +
    `${now.getFullYear()} — ${SEASON_BY_MONTH[now.getMonth()]}.`;
  if (!passingDate) return base;
  const passed = new Date(passingDate);
  if (Number.isNaN(passed.getTime()) || passed.getTime() >= now.getTime()) return base;
  return `${base} It has been ${elapsedPhrase(passed, now)}.`;
}
