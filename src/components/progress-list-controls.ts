/**
 * Pure list-control logic for the "My Progress" screen
 * (see .kiro/specs/leetsage-progress-quick-wins/design.md §3).
 *
 * This module holds the search / filter / sort logic as PURE functions so the
 * predicate + comparator are unit-testable under the repo's DOM-free vitest env
 * (`environment: 'node'`), exactly like `discovery-prompts.ts`. `ProgressView`
 * keeps `index` immutable and derives the visible list through
 * `filterSortProblems` — nothing here touches the DOM, storage, or the network.
 *
 * Design principle: `index` is the loaded data in its natural (recency) order;
 * the visible list is DERIVED from it. `sort: 'recent'` is therefore defined as
 * "preserve input order" (a pass-through), which makes the default view
 * byte-identical to today (requirements R3.7).
 */

import type { ProblemIndexEntry, ProblemPattern } from '../types';

type Difficulty = ProblemIndexEntry['difficulty'];

/** Sort fields offered by the list (requirements R3.1). */
export type SortKey = 'recent' | 'difficulty' | 'title';

/** Sort direction. Each field has a natural default (see SORT_OPTIONS). */
export type SortDir = 'asc' | 'desc';

/** A full sort spec: which field + which direction (bidirectional, R3.1). */
export interface Sort {
  key: SortKey;
  direction: SortDir;
}

/**
 * Transient + persisted list-control state. `query` / `difficulties` /
 * `patterns` are transient (reset on reopen, R1.6); only `sort` is persisted
 * (design §4.6, the documented R4.2 deviation).
 */
export interface ListControls {
  /** Case-insensitive substring match against the title. Trimmed; '' = no search. */
  query: string;
  /** Difficulty filter; empty set = no difficulty filter (all pass). */
  difficulties: Set<Difficulty>;
  /** Pattern filter; empty set = no pattern filter (all pass). */
  patterns: Set<ProblemPattern>;
  /** Sort field + direction applied AFTER filter + search. */
  sort: Sort;
}

/**
 * Each sort field's NATURAL default direction — what you get when you pick the
 * field (not when you flip it). `recent` defaults to `desc` (newest first) so the
 * default view is byte-identical to today (R3.7); difficulty defaults to `asc`
 * (Easy→Hard); title defaults to `asc` (A→Z).
 */
export const SORT_DEFAULT_DIR: Record<SortKey, SortDir> = {
  recent: 'desc',
  difficulty: 'asc',
  title: 'asc',
};

/** The default sort: recency, newest-first — matches today exactly (R3.7). */
export const DEFAULT_SORT: Sort = { key: 'recent', direction: 'desc' };

/** The no-controls state: reproduces today's view exactly (R3.7). */
export const DEFAULT_CONTROLS: ListControls = {
  query: '',
  difficulties: new Set<Difficulty>(),
  patterns: new Set<ProblemPattern>(),
  sort: { ...DEFAULT_SORT },
};

/**
 * Data the sort split-pills render from, in display order. `label` is the field
 * name; the direction caret is driven by the live `Sort` state in the UI.
 */
export const SORT_OPTIONS: ReadonlyArray<{ key: SortKey; label: string }> = [
  { key: 'recent', label: 'Recent' },
  { key: 'difficulty', label: 'Difficulty' },
  { key: 'title', label: 'A–Z' },
];

export function isSortKey(x: unknown): x is SortKey {
  return x === 'recent' || x === 'difficulty' || x === 'title';
}

function isSortDir(x: unknown): x is SortDir {
  return x === 'asc' || x === 'desc';
}

/**
 * Validate/normalize a persisted sort value, failing safe to the default when
 * missing, old (the previous bare-string format), or otherwise invalid — keeping
 * R3.7's "default behaves like today" true on any unexpected value. Accepts a
 * legacy bare `SortKey` string and upgrades it to that field's default direction.
 */
export function normalizeSort(x: unknown): Sort {
  if (isSortKey(x)) return { key: x, direction: SORT_DEFAULT_DIR[x] }; // legacy bare-string
  if (typeof x === 'object' && x !== null) {
    const o = x as Record<string, unknown>;
    if (isSortKey(o.key) && isSortDir(o.direction)) return { key: o.key, direction: o.direction };
    if (isSortKey(o.key)) return { key: o.key, direction: SORT_DEFAULT_DIR[o.key] };
  }
  return { ...DEFAULT_SORT };
}

/**
 * The sort state after clicking a field's LABEL.
 *
 * Clicking an INACTIVE field selects it at its natural default direction.
 * Clicking the ALREADY-ACTIVE field's label RESETS sort to the default
 * ({recent, desc}) — the "click again to undo my sort" affordance. There is no
 * "no sort" state (a list is always in some order), so "undo" means fall back to
 * the default order. Clicking Recent while already on the default is a no-op
 * (it returns the default again).
 */
export function selectOrResetSort(current: Sort, key: SortKey): Sort {
  if (current.key === key) return { ...DEFAULT_SORT };
  return { key, direction: SORT_DEFAULT_DIR[key] };
}

/**
 * The sort state after clicking a field's CARET (the direction toggle). If the
 * field is already active, flip its direction; if not, activate it at the
 * OPPOSITE of its default (the user asked for a direction explicitly, so a caret
 * click is never a dead click).
 */
export function toggleSortDirection(current: Sort, key: SortKey): Sort {
  if (current.key === key) {
    return { key, direction: current.direction === 'asc' ? 'desc' : 'asc' };
  }
  return { key, direction: SORT_DEFAULT_DIR[key] === 'asc' ? 'desc' : 'asc' };
}

/** Easy→Medium→Hard rank for the difficulty sort (stable, deterministic). */
const DIFFICULTY_RANK: Record<Difficulty, number> = { Easy: 0, Medium: 1, Hard: 2 };

/**
 * The canonical `ProblemPattern` order, mirrored as runtime data (a union type
 * can't be enumerated at runtime). The `satisfies` below is a COMPILE-TIME guard:
 * if a pattern is added to or removed from the `ProblemPattern` union, this array
 * stops matching `readonly ProblemPattern[]` with full coverage only if kept in
 * sync — see `PATTERN_ORDER_IS_EXHAUSTIVE` for the exhaustiveness pin.
 */
const PROBLEM_PATTERN_ORDER = [
  'Hash Map', 'Two Pointers', 'Sliding Window', 'Binary Search', 'BFS', 'DFS',
  'Backtracking', 'Dynamic Programming', 'Greedy', 'Stack', 'Queue', 'Heap',
  'Linked List', 'Tree', 'Graph', 'Sorting', 'Prefix Sum', 'Bit Manipulation',
  'Math', 'Recursion', 'Union Find', 'Trie', 'Other',
] as const satisfies readonly ProblemPattern[];

/**
 * Exhaustiveness pin: this fails to compile if any `ProblemPattern` is missing
 * from `PROBLEM_PATTERN_ORDER`. `Exclude<union, members>` collapses to `never`
 * only when every union member is covered; assigning a non-`never` to `never`
 * is a type error, so a newly-added pattern forces an update here.
 */
type _MissingPattern = Exclude<ProblemPattern, (typeof PROBLEM_PATTERN_ORDER)[number]>;
const PATTERN_ORDER_IS_EXHAUSTIVE: _MissingPattern extends never ? true : false = true;
void PATTERN_ORDER_IS_EXHAUSTIVE;

/**
 * Filter then sort the entries (R1.5 / R3.5). Composition:
 *   - title substring, case-insensitive (R1.2);
 *   - difficulty filter: OR within the category (R3.2);
 *   - pattern filter: entry matches if it has ANY selected pattern (OR within);
 *   - difficulty AND pattern AND search compose as AND across categories (R3.2).
 * Non-mutating: returns a new array; never reorders the input (so toggling a
 * filter off restores the full list unchanged).
 */
export function filterSortProblems(
  entries: ProblemIndexEntry[],
  controls: ListControls,
): ProblemIndexEntry[] {
  const q = controls.query.trim().toLowerCase();

  const filtered = entries.filter((e) => {
    if (q && !e.title.toLowerCase().includes(q)) return false;
    if (controls.difficulties.size > 0 && !controls.difficulties.has(e.difficulty)) return false;
    if (controls.patterns.size > 0 && !e.patterns.some((p) => controls.patterns.has(p))) return false;
    return true;
  });

  return sortEntries(filtered, controls.sort);
}

/**
 * Order a filtered list by field + direction (bidirectional, R3.1).
 *
 * The default `{recent, desc}` returns the input UNTOUCHED — the input is already
 * recency-desc on load, so trusting its order keeps the default path a pure
 * pass-through (R3.7). Every other field/direction sorts a COPY (never mutates
 * the input). Direction is applied by negating the comparator for the
 * non-default direction, with a stable title tiebreak that also flips so the
 * whole order reverses predictably.
 */
function sortEntries(entries: ProblemIndexEntry[], sort: Sort): ProblemIndexEntry[] {
  // The one pass-through case: recency, newest-first == the loaded order (R3.7).
  if (sort.key === 'recent' && sort.direction === 'desc') return entries;

  const copy = entries.slice();
  const dir = sort.direction === 'asc' ? 1 : -1;

  switch (sort.key) {
    case 'recent':
      // asc = oldest first, desc = newest first. (desc is also the pass-through
      // case above, but handling it here too keeps the comparator self-contained.)
      return copy.sort((a, b) => dir * (a.lastUpdatedAt - b.lastUpdatedAt));
    case 'title':
      return copy.sort((a, b) => dir * a.title.localeCompare(b.title));
    case 'difficulty':
      return copy.sort(
        (a, b) =>
          dir * (DIFFICULTY_RANK[a.difficulty] - DIFFICULTY_RANK[b.difficulty]) ||
          dir * a.title.localeCompare(b.title),
      );
  }
}

/**
 * The patterns actually present in the user's saved problems, de-duped and in
 * canonical order (R3.2 — offer only patterns the user has, not the full 23-value
 * vocabulary, which would be noise in a narrow panel).
 */
export function collectPatternFacets(entries: ProblemIndexEntry[]): ProblemPattern[] {
  const seen = new Set<ProblemPattern>();
  for (const e of entries) for (const p of e.patterns) seen.add(p);
  return PROBLEM_PATTERN_ORDER.filter((p) => seen.has(p));
}

/**
 * The href for a problem's LeetCode link, or `null` when there is no usable url
 * (R2.3/R2.4). Uses the STORED url as-is — no slug reconstruction, no
 * normalization (the importer already validates url against the slug, so the
 * stored value is the source of truth). A `null` return means "render no link".
 */
export function leetcodeHref(url: string | undefined | null): string | null {
  const u = (url ?? '').trim();
  return u.length > 0 ? u : null;
}
