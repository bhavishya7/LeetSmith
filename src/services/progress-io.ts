import type {
  ProblemRecord,
  Attempt,
  ProblemPattern,
  AttemptOutcome,
  ActionType,
  Complexity,
} from '../types';
import { PROBLEM_RECORD_SCHEMA_VERSION } from '../types';
import { computeInsights } from './progress-analytics';
import { computeBestAttemptIndex, migrate } from './progress-records';

/**
 * Progress export / import — mostly-pure I/O logic.
 * See .kiro/specs/leetsage-progress-export-import/{requirements,design}.md.
 *
 * DESIGN SHAPE (design §1): export is a boring serialize; IMPORT is the
 * dangerous direction — it ingests an untrusted file into privileged,
 * persistent storage. All the reasoning (serialize, validate, migrate, merge)
 * lives here as PURE functions so it's testable without the DOM/chrome APIs;
 * the impure edges (Blob download, FileReader, chrome.storage write) stay thin
 * in the UI / progress-records.
 *
 * GOVERNING RULE for import (R5.0): RECONSTRUCT, don't validate-in-place. We
 * never persist the parsed object; for each record we build a brand-new trusted
 * ProblemRecord by copying only known fields through per-field sanitizers.
 * Anything we didn't explicitly allow simply doesn't survive — an allowlist,
 * not a denylist. This structurally defeats unknown-field injection, prototype
 * pollution, and type confusion at once.
 */

// ---------------------------------------------------------------------------
// Export envelope (design §3)
// ---------------------------------------------------------------------------

/** The EXPORT file-format version. Independent of the record schema version. */
export const EXPORT_FORMAT_VERSION = 1;
/** Envelope discriminator — a foreign file that lacks this is rejected. */
export const EXPORT_FORMAT_ID = 'leetsage-progress';

/**
 * Versioned export envelope. Carries BOTH a file-format version AND the record
 * schema version, because the file format and the record schema evolve on
 * different clocks (design §3). The derived `progress_index` is deliberately
 * NOT exported — it's rebuilt from `records` on import (R2.2).
 */
export interface ProgressExport {
  format: typeof EXPORT_FORMAT_ID;
  formatVersion: number;      // the EXPORT file format version
  schemaVersion: number;      // PROBLEM_RECORD_SCHEMA_VERSION at export time
  exportedAt: number;         // epoch ms
  records: ProblemRecord[];   // the source of truth
}

// ---------------------------------------------------------------------------
// Import security caps (R5.2 — resource exhaustion / DoS)
// ---------------------------------------------------------------------------

/** Max raw file size, well under the ~10MB chrome.storage.local quota. */
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024; // 5 MB
/** Max records the envelope may carry. */
export const MAX_RECORDS = 5000;
/** Max attempts kept per record (excess are dropped). */
export const MAX_ATTEMPTS_PER_RECORD = 500;
/**
 * Max attempts across the WHOLE file (DoS). Per-record and per-file record caps
 * still allow MAX_RECORDS × MAX_ATTEMPTS_PER_RECORD attempts in theory; the
 * quota check would eventually fail-close, but this global ceiling rejects a
 * pathological file earlier and with a clearer message. Sized generously for
 * any realistic practice history.
 */
export const MAX_TOTAL_ATTEMPTS = 50_000;
/** Max length of a free-form string field (notes). Over-long is truncated. */
export const MAX_NOTES_LEN = 100_000;
/** Max length of a short string field (title, approach/solution summaries). */
export const MAX_SHORT_STR_LEN = 2_000;
/** Max slug length. */
export const MAX_SLUG_LEN = 200;
/** Earliest sane epoch-ms timestamp (2000-01-01) — rejects negatives/garbage. */
const MIN_TIMESTAMP = 946_684_800_000;
/** Latest sane timestamp: now + ~1 day of clock skew. */
const maxTimestamp = () => Date.now() + 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Known enum vocabularies (R5.4 — type confusion)
// ---------------------------------------------------------------------------

const DIFFICULTIES: ReadonlyArray<ProblemRecord['difficulty']> = ['Easy', 'Medium', 'Hard'];
const OUTCOMES: ReadonlyArray<AttemptOutcome> = ['solved', 'attempted', 'gave-up'];
/**
 * The full ActionType vocabulary (keep in sync with models.ts) — the allowlist
 * for the v2 `Attempt.usedActions` field (R4b.3). Importing is untrusted input
 * into privileged storage, so we accept ONLY these exact strings.
 */
const ACTION_TYPES: ReadonlyArray<ActionType> = [
  'GET_HINT', 'GENERATE_EXAMPLES', 'BREAK_DOWN_PROBLEM', 'EXPLAIN_CONCEPT',
  'CHECK_APPROACH', 'TIME_COMPLEXITY_HINT', 'PATTERN_RECOGNITION',
  'UNDERSTAND_SOLUTION', 'GENERATE_REPORT',
];
const ACTION_TYPE_SET = new Set<string>(ACTION_TYPES);
/** The full ProblemPattern vocabulary (keep in sync with models.ts). */
const PATTERNS: ReadonlyArray<ProblemPattern> = [
  'Hash Map', 'Two Pointers', 'Sliding Window', 'Binary Search', 'BFS', 'DFS',
  'Backtracking', 'Dynamic Programming', 'Greedy', 'Stack', 'Queue', 'Heap',
  'Linked List', 'Tree', 'Graph', 'Sorting', 'Prefix Sum', 'Bit Manipulation',
  'Math', 'Recursion', 'Union Find', 'Trie', 'Other',
];
const PATTERN_SET = new Set<string>(PATTERNS);

// ===========================================================================
// 1. Markdown report builder (R1) — combined study archive
// ===========================================================================

/** One attempt rendered as a single history line. */
function attemptLine(a: Attempt, index: number, bestIndex: number): string {
  const best = index === bestIndex ? ' — best' : '';
  const date = new Date(a.date).toLocaleDateString();
  const lang = a.language && a.language.trim() ? ` · ${a.language.trim()}` : '';
  const approach = a.approachSummary ? ` — ${a.approachSummary}` : '';
  return `${index + 1}. ${a.outcome}${best} · O(${stripO(a.complexity.time)}) time / O(${stripO(a.complexity.space)}) space · ${a.hintsUsed} hint${a.hintsUsed === 1 ? '' : 's'}${lang} · ${date}${approach}`;
}

/** Normalizes a complexity string to its inner part so we can re-wrap in O(...). */
function stripO(c: string): string {
  const m = (c || '').trim().match(/^o\((.*)\)$/i);
  return m ? m[1] : (c || '').trim();
}

/**
 * Builds the COMBINED Markdown report (R1): an insights summary header (from
 * computeInsights — the same source the Insights panel uses, so the doc and UI
 * never disagree) followed by full per-problem detail (title, difficulty,
 * patterns, attempts timeline, and the saved note). Pure.
 */
export function buildProgressReportMarkdown(records: ProblemRecord[], now: number = Date.now()): string {
  const dateStr = new Date(now).toISOString().slice(0, 10);
  if (records.length === 0) {
    return `# LeetSmith Progress — ${dateStr}\n\n_No saved problems yet._\n`;
  }

  const insights = computeInsights(records);

  // --- Summary header (R1.2) ---
  const lines: string[] = [];
  lines.push(`# LeetSmith Progress — ${dateStr}`);
  lines.push('');
  lines.push('## Summary');
  lines.push(`- Problems tracked: ${insights.totalProblems}`);
  lines.push(`- Attempts logged: ${insights.totalAttempts}`);
  if (insights.weakestLink) {
    const w = insights.weakestLink;
    const confidence = w.lowConfidence ? 'low confidence' : w.problemCount >= 6 ? 'high confidence' : 'medium confidence';
    lines.push(`- Weakest link: ${w.pattern} (${confidence}, based on ${w.problemCount} problem${w.problemCount === 1 ? '' : 's'}, avg ${w.avgHintsUsed.toFixed(1)} hints)`);
  }
  if (insights.byPattern.length > 0) {
    const dist = insights.byPattern
      .map(p => `${p.pattern} ×${p.problemCount}`)
      .join(', ');
    lines.push(`- Patterns: ${dist}`);
  }
  if (insights.revisit.length > 0) {
    const revisit = insights.revisit
      .slice(0, 10)
      .map(r => `${r.title} (${r.reason})`)
      .join(', ');
    lines.push(`- Worth revisiting: ${revisit}`);
  }
  lines.push('');

  // --- Per-problem detail (R1.3), newest first ---
  const detail = records
    .slice()
    .sort((a, b) => b.lastUpdatedAt - a.lastUpdatedAt)
    .map(r => {
      const header = `# ${r.title} (${r.difficulty})`;
      const meta = `_Patterns: ${r.patterns.join(', ') || 'none'} · ${r.attempts.length} attempt${r.attempts.length === 1 ? '' : 's'}_`;
      const history = r.attempts.length > 0
        ? `### History\n${r.attempts.map((a, i) => attemptLine(a, i, r.bestAttemptIndex)).join('\n')}`
        : '';
      const note = `### Note\n${r.notes || '(no note saved)'}`;
      return [header, meta, '', history, note].filter(Boolean).join('\n');
    })
    .join('\n\n---\n\n');

  return `${lines.join('\n')}\n---\n\n${detail}\n`;
}

// ===========================================================================
// 2. JSON export serializer (R2)
// ===========================================================================

/**
 * Builds the JSON export envelope (R2). Records are the source of truth; the
 * derived progress_index is intentionally omitted (rebuilt on import). Pure.
 */
export function buildProgressExport(records: ProblemRecord[], now: number = Date.now()): ProgressExport {
  return {
    format: EXPORT_FORMAT_ID,
    formatVersion: EXPORT_FORMAT_VERSION,
    schemaVersion: PROBLEM_RECORD_SCHEMA_VERSION,
    exportedAt: now,
    records,
  };
}

/** Serializes the export envelope to a pretty-printed JSON string. Pure. */
export function serializeProgressExport(records: ProblemRecord[], now: number = Date.now()): string {
  return JSON.stringify(buildProgressExport(records, now), null, 2);
}

// ===========================================================================
// 3. Import reconstructor / validator (R3, R5) — security-critical
// ===========================================================================

export interface ImportResult {
  /** The sanitized, migrated records that survived (empty on a hard fail). */
  records: ProblemRecord[];
  /** Count of records skipped because they were unsanitizable (R5.5.2). */
  skipped: number;
  /** Set on a HARD fail (size/parse/envelope) — the whole file is rejected. */
  error?: string;
}

/** Dangerous keys that must never be copied (R5.3 — prototype pollution). */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Reads a property from an untrusted object WITHOUT touching the prototype. */
function readProp(obj: Record<string, unknown>, key: string): unknown {
  if (FORBIDDEN_KEYS.has(key)) return undefined;
  // hasOwnProperty via Object.prototype so a hostile own "hasOwnProperty" can't lie.
  if (!Object.prototype.hasOwnProperty.call(obj, key)) return undefined;
  return obj[key];
}

/**
 * Neutralizes HTML in a rendered string field (R5.1), and length-caps (R5.2.1).
 *
 * We strip only TAG-FORMING `<` — a `<` immediately followed by a letter or `/`
 * (as in `<script`, `<img`, `</a`). That is the ONLY shape that can open or
 * close an HTML element; without it no tag can ever form, so `<img onerror=…>`,
 * `<script>`, and `javascript:` hrefs (which all require a tag) are inert. We
 * deliberately LEAVE bare comparison operators alone — `a < b`, `x > y`,
 * `arr[i] <= arr[j]`, `nums[mid] > nums[right]` — because `< ` / `<=` / a lone
 * `>` cannot start a tag, and stripping them was pure DATA LOSS in study notes
 * full of code and complexity prose (bug B20). We also DO NOT touch `&`, quotes,
 * or apostrophes: in text content those cannot start a tag, and escaping them
 * is (a) unnecessary and (b) NOT idempotent — e.g. `element's` → `element&#39;s`
 * → `element&amp;#39;s` would progressively corrupt legit prose across repeated
 * export/import cycles, and would show literal entities in the UI.
 *
 * IDEMPOTENCY: we remove only the tag-forming `<` character (e.g. `<script>` →
 * `script>`), never rewrite into entities. Once that `<` is gone the leftover
 * `script>` has only a bare `>` left, which is not tag-forming — so a second
 * pass is a no-op. Export→import→export→import is stable (the import pipeline
 * prizes idempotency — R5.1).
 *
 * This is defense-in-depth. The app's renderer builds React elements via JSX
 * (ContentDisplay.renderContent / the RecordDetail <pre>), and React escapes
 * text children by default — there is no dangerouslySetInnerHTML/innerHTML
 * anywhere — so raw HTML never executes even before this runs (verified for
 * R5.1.2 / security-audit #6/#14). Because that renderer layer already covers
 * XSS, this sanitizer can safely be the narrow tag-forming strip rather than
 * nuking every angle bracket.
 */
function neutralizeString(value: unknown, maxLen: number): string {
  if (typeof value !== 'string') {
    // Coerce non-strings defensively (numbers/booleans → their text), but never
    // objects (which would stringify to "[object Object]" noise).
    if (typeof value === 'number' || typeof value === 'boolean') value = String(value);
    else return '';
  }
  let s = value as string;
  // Drop control chars (keep tab/newline/carriage-return for note formatting).
  // eslint-disable-next-line no-control-regex -- stripping control chars is the intent here
  s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  // Strip ONLY tag-forming `<` (a `<` that opens/closes an element: `<` directly
  // followed by an ASCII letter or `/`). Remove just the `<`, leaving the rest
  // as inert text. Bare `<`/`>` used as comparison operators are preserved.
  // Idempotent: the result never contains a tag-forming `<` again.
  s = s.replace(/<(?=[a-zA-Z/])/g, '');
  if (s.length > maxLen) s = s.slice(0, maxLen);
  return s;
}

/** Coerces to a finite number in a sane range, else null (R5.4.1). */
function sanitizeTimestamp(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (n < MIN_TIMESTAMP || n > maxTimestamp()) return null;
  return n;
}

/** Coerces to a finite, non-negative, bounded integer (for hintsUsed). */
function sanitizeCount(value: unknown, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(Math.floor(n), max);
}

/**
 * Returns a SAFE problem URL (R5.4.1, future-proofing). We never trust the
 * file's url: it must be an `https://leetcode.com/problems/<slug>/…` URL whose
 * slug matches the record's (already strictly validated) slug; otherwise we
 * rebuild it deterministically from the slug. This closes a latent vector — the
 * url isn't rendered as a link today, but if a future "open on LeetCode" link
 * ever uses it, a `javascript:`/`http://evil` url would become a live
 * clickjack/XSS vector. Rebuilding from the trusted slug makes that impossible.
 */
function sanitizeUrl(value: unknown, slug: string): string {
  const fallback = `https://leetcode.com/problems/${slug}/`;
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  if (trimmed.length > 500) return fallback;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return fallback; // not an absolute URL (also rejects javascript:, data:, etc.)
  }
  // Enforce scheme + host + the problem path keyed to THIS record's slug.
  if (parsed.protocol !== 'https:') return fallback;
  if (parsed.hostname !== 'leetcode.com' && parsed.hostname !== 'www.leetcode.com') return fallback;
  if (!parsed.pathname.startsWith(`/problems/${slug}`)) return fallback;
  return trimmed;
}

/**
 * v2 — sanitizes the untrusted `usedActions` field to an allowlisted
 * `ActionType[]` (R4b.2/R4b.3). Accepts ONLY an array; keeps only strings in the
 * known ACTION_TYPES vocabulary; dedupes; caps to the vocabulary size (there are
 * only 9 action types). Anything else ⇒ `[]` — the SAME safe default the
 * storage-read migration uses for an old record (migrate() in
 * progress-records.ts), so the two paths cannot diverge (R4b.4; pinned by a
 * convergence test). Pure.
 */
export function sanitizeUsedActions(raw: unknown): ActionType[] {
  if (!Array.isArray(raw)) return [];
  const out: ActionType[] = [];
  for (const v of raw) {
    if (typeof v === 'string' && ACTION_TYPE_SET.has(v) && !out.includes(v as ActionType)) {
      out.push(v as ActionType);
    }
    if (out.length >= ACTION_TYPES.length) break; // can't exceed the vocabulary
  }
  return out;
}

/**
 * v2 — sanitizes an untrusted complexity object to a Complexity, or null when it
 * isn't a usable pair (R4b). Both time + space must be non-empty after
 * neutralizing (same treatment as Attempt.complexity). Returns null — NOT a
 * fabricated `O(?)` — so an absent/garbage optimal stays absent, which is what
 * signals "no flag" downstream (R3.4). Pure.
 */
export function sanitizeComplexity(raw: unknown): Complexity | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const time = neutralizeString(readProp(o, 'time'), 100);
  const space = neutralizeString(readProp(o, 'space'), 100);
  if (!time || !space) return null;
  return { time, space };
}

/** Reconstructs one Attempt from an untrusted entry, or null if unusable. */
function sanitizeAttempt(raw: unknown): Attempt | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;

  const date = sanitizeTimestamp(readProp(o, 'date'));
  if (date == null) return null; // an attempt with no valid date is meaningless

  const outcomeRaw = readProp(o, 'outcome');
  const outcome: AttemptOutcome = OUTCOMES.includes(outcomeRaw as AttemptOutcome)
    ? (outcomeRaw as AttemptOutcome)
    : 'attempted';

  const complexityRaw = readProp(o, 'complexity');
  const co = (complexityRaw && typeof complexityRaw === 'object')
    ? (complexityRaw as Record<string, unknown>)
    : {};

  const attempt: Attempt = {
    date,
    outcome,
    approachSummary: neutralizeString(readProp(o, 'approachSummary'), MAX_SHORT_STR_LEN),
    solutionSummary: neutralizeString(readProp(o, 'solutionSummary'), MAX_SHORT_STR_LEN),
    complexity: {
      time: neutralizeString(readProp(co, 'time'), 100) || 'O(?)',
      space: neutralizeString(readProp(co, 'space'), 100) || 'O(?)',
    },
    hintsUsed: sanitizeCount(readProp(o, 'hintsUsed'), 1000),
    // v2 — the missed touch-point (R4b.1): copy + allowlist usedActions. Always
    // set (default [] when absent/garbage), matching the migration default.
    usedActions: sanitizeUsedActions(readProp(o, 'usedActions')),
  };
  const language = neutralizeString(readProp(o, 'language'), 100);
  if (language) attempt.language = language;
  // v2 — optimalComplexity: set ONLY when present + valid; absent ⇒ no flag.
  const optimal = sanitizeComplexity(readProp(o, 'optimalComplexity'));
  if (optimal) attempt.optimalComplexity = optimal;
  // v2 — chatCount: a bounded non-negative integer; set only when positive so
  // an old record (absent) and an explicit 0 behave identically (parity with
  // the storage read). Capped defensively like every imported count.
  const chatCount = sanitizeCount(readProp(o, 'chatCount'), 10_000);
  if (chatCount > 0) attempt.chatCount = chatCount;
  return attempt;
}

/**
 * Reconstructs one ProblemRecord from an untrusted parsed entry (R5.0). Builds
 * a FRESH object by explicit per-field assignment — never spreads/assigns the
 * untrusted object — copying only known fields through sanitizers. Returns null
 * (⇒ skip + count) if the record can't be made trustworthy. Pure.
 */
export function sanitizeRecord(raw: unknown): ProblemRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;

  // slug — the primary key. Must match the strict slug grammar (R5.4.1).
  const slugRaw = readProp(o, 'slug');
  if (typeof slugRaw !== 'string') return null;
  const slug = slugRaw.trim();
  if (!/^[a-z0-9-]+$/.test(slug) || slug.length > MAX_SLUG_LEN) return null;

  // difficulty — strict enum, default Medium (R5.4.1).
  const diffRaw = readProp(o, 'difficulty');
  const difficulty: ProblemRecord['difficulty'] = DIFFICULTIES.includes(diffRaw as ProblemRecord['difficulty'])
    ? (diffRaw as ProblemRecord['difficulty'])
    : 'Medium';

  // patterns — filter to the known vocabulary, dedupe (R5.4.1).
  const patternsRaw = readProp(o, 'patterns');
  const patterns: ProblemPattern[] = [];
  if (Array.isArray(patternsRaw)) {
    for (const p of patternsRaw) {
      if (typeof p === 'string' && PATTERN_SET.has(p) && !patterns.includes(p as ProblemPattern)) {
        patterns.push(p as ProblemPattern);
      }
    }
  }

  // attempts — reconstruct each, cap the count (R5.2.1). Drop unusable ones.
  const attemptsRaw = readProp(o, 'attempts');
  const attempts: Attempt[] = [];
  if (Array.isArray(attemptsRaw)) {
    for (const a of attemptsRaw.slice(0, MAX_ATTEMPTS_PER_RECORD)) {
      const sane = sanitizeAttempt(a);
      if (sane) attempts.push(sane);
    }
  }

  // timestamps — finite + sane range; fall back sensibly.
  const now = Date.now();
  const lastUpdatedAt = sanitizeTimestamp(readProp(o, 'lastUpdatedAt'))
    ?? (attempts.length ? attempts[attempts.length - 1].date : now);
  const firstSolvedAt = sanitizeTimestamp(readProp(o, 'firstSolvedAt'))
    ?? (attempts.length ? attempts[0].date : lastUpdatedAt);

  const record: ProblemRecord = {
    schemaVersion: PROBLEM_RECORD_SCHEMA_VERSION,
    slug,
    // url is validated to the LeetCode problem shape (or rebuilt from slug) so
    // a future "open on LeetCode" link can never carry a javascript:/evil URL.
    url: sanitizeUrl(readProp(o, 'url'), slug),
    title: neutralizeString(readProp(o, 'title'), MAX_SHORT_STR_LEN) || slug,
    difficulty,
    patterns,
    attempts,
    // R5.4.2 — IGNORE the file's bestAttemptIndex; recompute it.
    bestAttemptIndex: computeBestAttemptIndex(attempts),
    firstSolvedAt,
    lastUpdatedAt,
    notes: neutralizeString(readProp(o, 'notes'), MAX_NOTES_LEN),
  };
  return record;
}

/**
 * The full import pipeline (design §4). PURE and NEVER throws: hard failures
 * (size / parse / envelope) return `{ records: [], skipped: 0, error }`;
 * individually bad records are skipped and counted. The caller does the
 * (impure) merge + write only when there's no `error`.
 */
export function parseImport(text: string): ImportResult {
  // Stage 1 — size gate (R5.2.1). Reject before parsing.
  // Byte length, not string length, to match the file on disk.
  const byteLen = typeof TextEncoder !== 'undefined'
    ? new TextEncoder().encode(text).length
    : text.length;
  if (byteLen > MAX_IMPORT_BYTES) {
    return { records: [], skipped: 0, error: `File too large (max ${Math.round(MAX_IMPORT_BYTES / 1024 / 1024)}MB).` };
  }

  // Stage 2 — parse (R5.5.1). Never eval; JSON.parse in try/catch.
  // Cheap pre-check so a clearly-non-JSON file (e.g. a .md or binary picked by
  // mistake) gets a friendly, specific message instead of a parser error. The
  // picker's `accept=".json"` is only a hint — the user can choose any file.
  const head = text.trimStart()[0];
  if (head !== '{' && head !== '[') {
    return { records: [], skipped: 0, error: "That doesn't look like a JSON file. Import the .json backup you exported from LeetSmith." };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { records: [], skipped: 0, error: "That file isn't valid JSON. Import the .json backup you exported from LeetSmith." };
  }

  // Stage 3 — envelope gate (R5.5.1).
  if (!parsed || typeof parsed !== 'object') {
    return { records: [], skipped: 0, error: 'Not a LeetSmith progress file.' };
  }
  const env = parsed as Record<string, unknown>;
  if (readProp(env, 'format') !== EXPORT_FORMAT_ID) {
    return { records: [], skipped: 0, error: 'Not a LeetSmith progress file (missing the format marker).' };
  }
  const fv = Number(readProp(env, 'formatVersion'));
  if (!Number.isFinite(fv) || fv < 1 || fv > EXPORT_FORMAT_VERSION) {
    return { records: [], skipped: 0, error: `Unsupported export version (${readProp(env, 'formatVersion')}).` };
  }
  const recordsRaw = readProp(env, 'records');
  if (!Array.isArray(recordsRaw)) {
    return { records: [], skipped: 0, error: 'Progress file has no records array.' };
  }
  if (recordsRaw.length > MAX_RECORDS) {
    return { records: [], skipped: 0, error: `Too many records (max ${MAX_RECORDS}).` };
  }

  // Global attempts cap (R5.2.1) — reject a pathological file (e.g. 5000
  // records each claiming a huge attempts[]) fast, before reconstructing
  // everything, and before the quota check would eventually catch it. We count
  // the RAW declared attempts cheaply; the per-record cap still applies after.
  let declaredAttempts = 0;
  for (const raw of recordsRaw) {
    if (raw && typeof raw === 'object') {
      const a = readProp(raw as Record<string, unknown>, 'attempts');
      if (Array.isArray(a)) declaredAttempts += a.length;
    }
    if (declaredAttempts > MAX_TOTAL_ATTEMPTS) {
      return { records: [], skipped: 0, error: `Too many attempts in file (max ${MAX_TOTAL_ATTEMPTS}).` };
    }
  }

  // Stage 4 — reconstruct each record (per-record skip). Stage 5 — migrate.
  const records: ProblemRecord[] = [];
  let skipped = 0;
  for (const raw of recordsRaw) {
    const sane = sanitizeRecord(raw);
    if (!sane) { skipped++; continue; }
    records.push(migrate(sane));
  }

  return { records, skipped };
}

// ===========================================================================
// 4. Merge logic (R3.3) — newer-wins per slug, idempotent
// ===========================================================================

export interface MergeSummary {
  added: number;
  updated: number;
  /** Incoming records dropped because an existing record was newer/same. */
  skipped: number;
}

export interface MergeResult {
  merged: ProblemRecord[];
  summary: MergeSummary;
}

/**
 * Merges incoming records into existing ones, NEWER-WINS per slug by
 * lastUpdatedAt (R3.3). Adds new slugs; for a collision keeps whichever record
 * has the later lastUpdatedAt (ties keep existing → re-importing the same file
 * is a no-op). Idempotent and order-independent — standard last-writer-wins
 * conflict resolution. v1 merges WHOLE records (per-attempt union is deferred).
 * Pure.
 */
export function mergeRecords(existing: ProblemRecord[], incoming: ProblemRecord[]): MergeResult {
  const bySlug = new Map<string, ProblemRecord>();
  for (const r of existing) bySlug.set(r.slug, r);

  let added = 0;
  let updated = 0;
  let skipped = 0;

  for (const inc of incoming) {
    const cur = bySlug.get(inc.slug);
    if (!cur) {
      bySlug.set(inc.slug, inc);
      added++;
    } else if (inc.lastUpdatedAt > cur.lastUpdatedAt) {
      bySlug.set(inc.slug, inc);
      updated++;
    } else {
      skipped++; // existing is newer or equal — keep it (idempotent)
    }
  }

  return { merged: [...bySlug.values()], summary: { added, updated, skipped } };
}
