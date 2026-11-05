import type { ProblemRecord, ProblemIndexEntry, Attempt, ProblemPattern } from '../types';
import { PROBLEM_RECORD_SCHEMA_VERSION } from '../types';

/**
 * Persistent progress records (Progress-Tracking Phase B).
 * See .kiro/specs/leetsage-progress-tracking/design.md §3–§6.
 *
 * Storage layout (design §3.2, "one key per record + a light index"):
 *   progress_index        -> ProblemIndexEntry[]   (small projection for the list/analytics)
 *   record_{slug}         -> ProblemRecord         (full record)
 *
 * Saving one problem writes only that record's key + the small index, instead
 * of rewriting one giant blob. The "My Progress" list renders from the index
 * alone. The cost is keeping index and records in sync on write (read
 * optimization vs. write amplification / consistency).
 */

const INDEX_KEY = 'progress_index';
const recordKey = (slug: string) => `record_${slug}`;

/**
 * Derives the stable slug from a normalized problem URL
 * (`https://leetcode.com/problems/{slug}/`). This mirrors the content script's
 * normalizeProblemUrl but lives here so the side-panel context doesn't import
 * across the content-script boundary. Falls back to the raw string if the URL
 * doesn't match, so a record is still keyed by *something* stable.
 */
export function slugFromUrl(url: string): string {
  const match = url.match(/\/problems\/([^/?#]+)/i);
  return match ? match[1] : url;
}

// ---- low-level get/set (promise-wrapped chrome.storage, matching storage.ts) ----

function getKey<T>(key: string): Promise<T | null> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(key, (result) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve((result[key] as T) ?? null);
    });
  });
}

function setKey(key: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [key]: value }, () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}

function removeKey(key: string): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.remove(key, () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}

// ---- index ----------------------------------------------------------------

export async function getProgressIndex(): Promise<ProblemIndexEntry[]> {
  return (await getKey<ProblemIndexEntry[]>(INDEX_KEY)) ?? [];
}

async function upsertIndexEntry(entry: ProblemIndexEntry): Promise<void> {
  const index = await getProgressIndex();
  const i = index.findIndex(e => e.slug === entry.slug);
  if (i >= 0) index[i] = entry; else index.push(entry);
  await setKey(INDEX_KEY, index);
}

async function removeIndexEntry(slug: string): Promise<void> {
  const index = await getProgressIndex();
  await setKey(INDEX_KEY, index.filter(e => e.slug !== slug));
}

function toIndexEntry(record: ProblemRecord): ProblemIndexEntry {
  return {
    slug: record.slug,
    url: record.url,
    title: record.title,
    difficulty: record.difficulty,
    patterns: record.patterns,
    attemptCount: record.attempts.length,
    lastUpdatedAt: record.lastUpdatedAt,
  };
}

// ---- records --------------------------------------------------------------

export async function getRecord(slug: string): Promise<ProblemRecord | null> {
  const raw = await getKey<ProblemRecord>(recordKey(slug));
  return raw ? migrate(raw) : null;
}

/** Loads every full record (migrated). Used by export + import merge. */
export async function getAllRecords(): Promise<ProblemRecord[]> {
  const index = await getProgressIndex();
  const recs = await Promise.all(index.map(e => getRecord(e.slug)));
  return recs.filter((r): r is ProblemRecord => !!r);
}

/**
 * Schema migration (design §6). Applied on every read. Ordered, idempotent
 * steps bring an older record up to the current shape; running it on an
 * already-current record is a no-op. Cheap now, painful to retrofit later.
 */
export function migrate(record: ProblemRecord): ProblemRecord {
  let r = record;
  if (r.schemaVersion == null) r = { ...r, schemaVersion: 1 };
  // v1 → v2 (leetsage-progress-insights-overhaul): two new per-Attempt fields.
  // Default an old attempt's usedActions to [] (⇒ no tool-depth ⇒ never scored
  // as struggle) and leave optimalComplexity ABSENT (⇒ the achieved-vs-optimal
  // flag can't fire ⇒ never a false "suboptimal"). This defaulting rule is the
  // SAME one the import sanitizer applies (progress-io.ts sanitizeAttempt), so
  // an old stored record and an old imported file end up identical — pinned by
  // a convergence test. See models.ts PROBLEM_RECORD_SCHEMA_VERSION (the
  // three-touch-point rule).
  if (r.schemaVersion < 2) {
    r = {
      ...r,
      attempts: r.attempts.map(a => (a.usedActions ? a : { ...a, usedActions: [] })),
      schemaVersion: 2,
    };
  }
  return r;
}

export interface SaveAttemptInput {
  slug: string;
  url: string;
  title: string;
  difficulty: 'Easy' | 'Medium' | 'Hard';
  patterns: ProblemPattern[];
  attempt: Attempt;
  /** The generated report markdown, stored as the record's notes. */
  notes: string;
}

/**
 * The save write-path (design §3.3): read the existing record, then decide
 * whether this save is a NEW attempt or an in-place update of the latest one,
 * recompute bestAttemptIndex, union the patterns, bump timestamps, write the
 * record, then upsert the index entry.
 *
 * WHY the append/replace decision (see design §3.1): a save click is not a
 * "solving attempt". Clicking Save (or re-generating and re-saving) the same
 * solution on the same day should NOT inflate the attempt log. We append a
 * genuinely new attempt only when this looks like a real re-solve — a different
 * calendar day, OR a changed approach/complexity. Otherwise we replace the
 * latest attempt in place (refresh its note + timestamp). This keeps
 * attempts[] an honest event log until Phase D can capture verified
 * submissions. (The attempt COUNT is deliberately hidden in the UI for now —
 * see §3.1 — because even a de-duped attempt is inferred, not verified.)
 *
 * This is a classic read-modify-write. chrome.storage is async and the panel is
 * single-user/local, so the interleaving risk is low; we don't guard it with a
 * lock in v1 (the correct mental model would be "serialize writes to the same
 * key" — noted, not implemented).
 */
export async function saveAttempt(input: SaveAttemptInput): Promise<ProblemRecord> {
  const now = Date.now();
  const existing = await getRecord(input.slug);

  const prevAttempts = existing?.attempts ?? [];
  const latest = prevAttempts[prevAttempts.length - 1];
  const attempts = shouldReplaceLatest(latest, input.attempt)
    ? [...prevAttempts.slice(0, -1), input.attempt]   // update the latest in place
    : [...prevAttempts, input.attempt];               // genuinely new attempt
  const patterns = unionPatterns(existing?.patterns ?? [], input.patterns);

  const record: ProblemRecord = {
    schemaVersion: PROBLEM_RECORD_SCHEMA_VERSION,
    slug: input.slug,
    url: input.url,
    title: input.title || existing?.title || input.slug,
    difficulty: input.difficulty ?? existing?.difficulty ?? 'Medium',
    patterns,
    attempts,
    bestAttemptIndex: computeBestAttemptIndex(attempts),
    firstSolvedAt: existing?.firstSolvedAt ?? now,
    lastUpdatedAt: now,
    notes: input.notes || existing?.notes || '',
  };

  await setKey(recordKey(record.slug), record);
  await upsertIndexEntry(toIndexEntry(record));
  return record;
}

export async function deleteRecord(slug: string): Promise<void> {
  await removeKey(recordKey(slug));
  await removeIndexEntry(slug);
}

// ---- import write-path (design §4 step 7; R3.5/R3.6) ----------------------

/**
 * Safe storage budget for the whole merged set, in bytes. chrome.storage.local
 * has a ~10MB (10,485,760) quota; we stay well under it so import fails closed
 * (R5.2.2) rather than pushing the store over quota and corrupting it.
 */
const STORAGE_BUDGET_BYTES = 8 * 1024 * 1024; // 8 MB

/** Rough byte size of a JSON-serializable value (UTF-8 approximation). */
function approxByteSize(value: unknown): number {
  const json = JSON.stringify(value);
  return typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(json).length : json.length;
}

export interface WriteImportedResult {
  /** True when the write completed. */
  ok: boolean;
  /** Present when we failed closed (e.g. over budget) — nothing was written. */
  error?: string;
}

/**
 * Writes an already-merged record set to storage and REBUILDS the
 * progress_index from it (R3.6). Atomic w.r.t. existing data (R3.5): everything
 * is validated/assembled in memory first, a quota check runs, and only then do
 * we hand the whole payload to a SINGLE chrome.storage.local.set call — Chrome
 * applies a multi-key set atomically, so a failure can't half-update the store.
 *
 * `previousSlugs` are the slugs present BEFORE this write; any that are no
 * longer in `merged` would be orphaned records — but merge only ever adds/keeps
 * slugs, so in practice this stays empty. We remove orphans defensively so the
 * index and record keys can't drift.
 */
export async function writeImportedRecords(
  merged: ProblemRecord[],
  previousSlugs: string[] = [],
): Promise<WriteImportedResult> {
  // Rebuild the index projection from the merged records (never trust a file's).
  const index = merged.map(toIndexEntry);

  // Assemble the full write payload in memory (validate-all-then-write).
  const payload: Record<string, unknown> = { [INDEX_KEY]: index };
  for (const r of merged) payload[recordKey(r.slug)] = r;

  // Quota check — fail closed if the merged set would blow the budget (R5.2.2).
  const size = approxByteSize(payload);
  if (size > STORAGE_BUDGET_BYTES) {
    return {
      ok: false,
      error: `Import would exceed the storage budget (${Math.round(size / 1024 / 1024)}MB > ${Math.round(STORAGE_BUDGET_BYTES / 1024 / 1024)}MB). Nothing was changed.`,
    };
  }

  // Single atomic multi-key set.
  await new Promise<void>((resolve, reject) => {
    chrome.storage.local.set(payload, () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });

  // Defensively drop any record key that's no longer in the merged set.
  const mergedSlugs = new Set(merged.map(r => r.slug));
  const orphans = previousSlugs.filter(s => !mergedSlugs.has(s));
  if (orphans.length > 0) {
    await new Promise<void>((resolve, reject) => {
      chrome.storage.local.remove(orphans.map(recordKey), () => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve();
      });
    });
  }

  return { ok: true };
}

// ---- pure helpers (unit-test targets) -------------------------------------

/** True if two epoch-ms timestamps fall on the same local calendar day. */
export function sameCalendarDay(a: number, b: number): boolean {
  const da = new Date(a), db = new Date(b);
  return da.getFullYear() === db.getFullYear()
    && da.getMonth() === db.getMonth()
    && da.getDate() === db.getDate();
}

/**
 * Whether an incoming save should REPLACE the latest attempt rather than append
 * a new one. Replace when it's the same calendar day AND the approach and both
 * complexity fields are unchanged — i.e. a re-save of the same solution, not a
 * real re-solve. Any change in approach or complexity, or a later day, is a new
 * attempt. (Pure — unit-test target. See design §3.1.)
 */
export function shouldReplaceLatest(latest: Attempt | undefined, incoming: Attempt): boolean {
  if (!latest) return false;
  if (!sameCalendarDay(latest.date, incoming.date)) return false;
  return (
    latest.approachSummary === incoming.approachSummary &&
    latest.complexity.time === incoming.complexity.time &&
    latest.complexity.space === incoming.complexity.space
  );
}

/** Union two pattern lists, preserving order and dropping duplicates. */
export function unionPatterns(a: ProblemPattern[], b: ProblemPattern[]): ProblemPattern[] {
  const out: ProblemPattern[] = [...a];
  for (const p of b) if (!out.includes(p)) out.push(p);
  return out;
}

/**
 * "Best so far" = a solved attempt with the lowest complexity cost, tie-broken
 * by fewest hints. If nothing is solved, the most recent attempt. Denormalized
 * onto the record so reads don't recompute it (design §3.1).
 */
export function computeBestAttemptIndex(attempts: Attempt[]): number {
  if (attempts.length === 0) return -1;
  const solved = attempts
    .map((a, i) => ({ a, i }))
    .filter(x => x.a.outcome === 'solved');
  const pool = solved.length > 0 ? solved : attempts.map((a, i) => ({ a, i }));
  pool.sort((x, y) => {
    const c = complexityRank(x.a.complexity.time) - complexityRank(y.a.complexity.time);
    if (c !== 0) return c;
    return x.a.hintsUsed - y.a.hintsUsed;
  });
  return pool[0].i;
}

/**
 * Coarse ordering of common Big-O time classes so we can compare attempts.
 * Not exhaustive — unknown/odd notations sort to the middle so they never
 * falsely win "best". Normalizes case and whitespace.
 */
export function complexityRank(bigO: string): number {
  const s = (bigO || '').toLowerCase().replace(/\s+/g, '');
  const table: Array<[RegExp, number]> = [
    [/^o\(1\)$/, 0],
    [/^o\(log/, 1],
    [/^o\(n\)$/, 2],
    [/^o\(nlog/, 3],
    [/^o\(n\^?2\)$/, 4],
    [/^o\(n\^?3\)$/, 5],
    [/^o\(2\^n\)$/, 6],
    [/^o\(n!\)$/, 7],
  ];
  for (const [re, rank] of table) if (re.test(s)) return rank;
  return 3.5; // unknown → middle, never a false "best"
}
