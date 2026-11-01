# Progress Screen Quick Wins — Design

> **Phase: design — awaiting sign-off.** Per `.kiro/steering/workflow.md` this
> session did the deep code read first, now writes design, and **pauses for the
> user's sign-off before writing tasks**. Requirements are signed off in
> [`requirements.md`](./requirements.md).
>
> **Scope:** three navigation improvements to the "My Progress" screen —
> R1 search, R2 per-problem LeetCode link, R3 filter + sort controls. Read-only
> over the already-in-memory `ProblemIndexEntry[]`. NO schema/permission/network
> change. The insights/analytics overhaul is the SIBLING spec
> `leetsage-progress-insights-overhaul` and is explicitly out of scope here.
>
> ### Design decisions settled with the user after the first draft
>
> 1. **Sort control = styled segmented pills, NOT a native `<select>`.** A native
>    select renders its popup with OS-native chrome that Tailwind can't reach
>    (wrong font/arrow/highlight, and a light-mode OS list even in dark theme) —
>    it reads as a foreign element in the panel. Three segmented toggle-pills
>    (Recent · Difficulty · Title) keep the whole controls band in one visual
>    language, are fully theme-correct, and need no popup to manage. See §4.2.
> 2. **Sort persists across sessions; search + filters stay transient.** This is a
>    DELIBERATE, documented deviation from requirements **R1.6** ("search transient")
>    and **R4.2** ("NO new storage"): the user asked for the durable sort
>    preference to survive a reopen, while search and difficulty/pattern filters
>    remain a transient navigation act (so a stale filter never silently hides
>    most of the list on reopen). This adds exactly ONE small `chrome.storage.local`
>    key holding a single enum string. See §4.6. This deviation is recorded here
>    (not in requirements.md) per the workflow rule to document drift rather than
>    let it happen silently.

---

## REVISION 2 — post-first-build UX overhaul (user eyeball review)

> The first implementation (§§3–9 below) shipped functionally correct and passed
> build + 562 tests, but the user's visual review of the built extension called
> for a layout + polish pass. These revisions supersede the specific sub-sections
> noted; the pure-logic core (§3) is unchanged except where stated. Recorded here
> so the "where did this come from?" answer is always in the doc.

**R2.1 — Search stays title-only.** Considered extending to pattern names;
rejected by the user — pattern filtering already exists via the pattern control,
so title-only keeps search predictable. (§3.2 unchanged.)

**R2.2 — Pattern filter becomes a multi-select DROPDOWN; Sort + Difficulty stay
pills.** The pattern vocabulary present can be 10+ values, which wrapped into a
wall of chips (the user flagged the asymmetry vs. 3-value Sort/Difficulty). Sort
and Difficulty stay inline segmented/toggle pills (few, fixed, one-tap). Pattern
moves to a compact `Pattern ▾` trigger that opens a checkbox menu, reusing the
SHIPPED Download ▾ dropdown pattern (`role="menu"`, outside-click + Escape close).
The trigger shows an active count, e.g. `Pattern (2) ▾`. Omitted entirely when the
user has no patterns. See revised §4.2.

**R2.3 — Difficulty pills carry the E/M/H colors.** Selected Easy = green,
Medium = amber, Hard = red (reusing the existing `difficultyColor` hues) rather
than a generic blue, so they are instantly scannable and consistent with the
per-row difficulty labels. See revised §4.2.

**R2.4 — Section labels bigger.** "Sort:" / "Difficulty:" / "Pattern:" go from
`text-[10px]` neutral-400 to `text-[11px]`/`text-xs` medium-weight, deeper color —
they read as real labels, not metadata.

**R2.5 — LeetCode link becomes a REAL inline `<a>` next to the title (option B).**
The first build placed a bordered ↗ box as a sibling to the right of the row — the
user found it ugly and the interaction model unclear. The row is restructured from
a single `<button>` into a **`<div role="button">`** row (keyboard-accessible:
`tabIndex=0`, Enter/Space opens detail) so a genuine `<a>` can sit INLINE right
after the title with `onClick`/`onKeyDown` `stopPropagation`. Result: clicking
anywhere on the box opens the in-panel detail; clicking the inline ↗ opens LeetCode
in a new tab — structurally distinct targets, no nested-interactive HTML, real-link
affordances preserved (middle-click, copy link). The ↗ is subtle (neutral, blue on
hover) but distinct, with the `title`/`aria-label` tooltip. Supersedes §4.4. (§4.5
detail-view link keeps its header placement.)

**R2.6 — Data actions (Copy all / Download / Import) move to the HEADER as
icon-only buttons.** To reclaim vertical space, the three actions leave their own
band and become compact icon buttons in the title row, clustered left of a gapped
`✕` close. Tooltips (already present) carry the labels. The `(31)` count is
REMOVED from the header (it already lives in the Insights card, so it's redundant).
Supersedes the §4 toolbar-band placement.

**R2.7 — Real SVG icons (no library).** The project has **no icon library**
(verified: no lucide/react-icons/heroicons/feather/phosphor) — icons are hardcoded
Unicode glyphs, with one precedent for an inline `<svg>` (`UsageReservoir.tsx`).
The generic ⬇/⬆ glyphs read as "arrow," not "download/import," and vary by OS. We
add a new `src/components/icons.tsx` with small inline SVG components
(`DownloadIcon` = arrow descending into an open tray, `ImportIcon` = the mirror
arrow ascending out of the tray, `CopyIcon`, and an `ExternalLinkIcon` ↗ for the
LeetCode link). All inherit `currentColor` (theme-correct) and carry no deps. These
are simple geometric paths authored in-repo, not third-party art.

**R2.8 — Fixed vs. scrolling layout.** Only the controls used *while browsing* are
pinned; everything else scrolls. Final top-to-bottom order:
```
┌ header: My Progress + [⧉ ⬇▾ ⬆]   [✕] ┐  FIXED
├ search · sort · difficulty · pattern ─┤  FIXED
├───────────────────────────────────────┤
│ Insights card                         │  ⎫
│ problem rows …                         │  ⎬ SCROLLS
│ "stored locally…" disclaimer (last)   │  ⎭
└───────────────────────────────────────┘
```
Insights scrolls at the top of the scroll area (collapsible insights deferred —
it's the sibling insights-overhaul spec's territory). The local-storage disclaimer
moves to the BOTTOM of the scroll area (a footnote to the whole list) so it stops
occupying a permanent middle band. The import-feedback banner stays near the top of
the scroll region (transient status). Supersedes the §4 note/toolbar ordering.

**Scope note:** all of REVISION 2 is still UI/UX + presentation over the same
in-memory data. No new data model, permission, or network. The one storage key
(persisted sort, §4.6) is unchanged. The pure logic (§3) is unchanged.

---

## REVISION 3 — bidirectional sort + sort/filter visual split (second eyeball)

> A second visual review surfaced three more items. These touch the pure sort
> logic (§3) for the first time, so they're captured carefully. Still UI + the
> sort comparator only — no data-model/permission/network change.

**R3.1-rev — Sort is now BIDIRECTIONAL (`{key, direction}`).** The first build
only sorted one way per field (Recent = newest-only, Difficulty = Easy→Hard-only).
A sort control that can't reverse is incomplete. `ListControls.sort` changes from a
bare `SortKey` to `Sort = { key: SortKey; direction: 'asc' | 'desc' }`. Each field
has a natural default direction (`SORT_DEFAULT_DIR`): recent→desc (newest first),
difficulty→asc (Easy→Hard), title→asc (A→Z). `sortEntries` applies direction by
negating the comparator (with the title tiebreak flipping too, so the whole order
reverses predictably). The default `{recent, desc}` remains the exact pass-through
of the loaded order — R3.7 is preserved (and pinned by a test).

**R3.2-rev — Split-pill interaction (user-specified).** Each sort field renders as
ONE pill with TWO sibling hit areas (not nested — two `<button>`s styled as one
connected pill, to keep interactive HTML valid): the **label** selects the field
at its default direction; the **caret** flips direction (and activates the field at
the opposite of its default if it wasn't active, so a caret click is never a dead
click). The active pill shows a ▲/▼ caret reflecting the live direction. Pure
helpers `selectSort(key)` and `toggleSortDirection(current, key)` encode this and
are unit-tested. Chosen over "two clicks to cycle off" because it's fewer clicks
and the direction is always explicit/visible.

**R3.3-rev — Sort labels + sort/filter visual separation.** Sort options are
**Recent · Difficulty · A–Z** (the `title` key keeps its value; only its label is
"A–Z"). A horizontal divider separates the SORT row from the DIFFICULTY/PATTERN
filter rows so "order the list" vs. "narrow the list" read as distinct zones —
fixing the reported confusion where "Difficulty" appeared both as a sort and a
filter. The pattern dropdown's resting label changed from the bare word "Pattern"
(which looked like a selected value) to **"Choose patterns"** / **"N selected"**.

**R3.4-rev — Difficulty pills colored at rest.** The E/M/H filter pills now carry
their green/amber/red color in the TEXT even when unselected (via `PILL_REST_TONE`),
so they're scannable like the always-colored per-row difficulty tags; the whole
pill still lights up (fill + border) when selected. (The first build only colored
the selected state, which read as "no colors.")

**Persistence (§4.6) updated:** the stored value is now the `{key, direction}`
object. `normalizeSort()` fails safe to `{recent, desc}` on a missing/invalid
value AND upgrades a legacy bare-`SortKey` string (from the first build) to that
field's default direction — so an older stored value migrates cleanly instead of
resetting. Unit-tested.

**Tooltips:** left as native `title` (user-confirmed). Native-`title` hover delay/
quirks are browser behavior, not our bug; a custom tooltip component is noted as a
possible future enhancement, not built here.

---

## REVISION 4 — sort-undo, pattern pills, inline-icon wrap, + a save-persistence bug

> A third eyeball pass plus two bugs found in daily use. The first two items
> refine REVISION 3's controls; the last two are genuine bugs (one layout, one a
> real state-persistence defect in the report Save button that lives OUTSIDE this
> screen but was surfaced while testing it).

**R4.1-rev — Clicking the ACTIVE sort field's label resets to the default sort.**
REVISION 3 made the label always re-select (no way to "undo" a sort back to the
default via the label). Now `selectOrResetSort(current, key)`: clicking an
inactive field selects it at its default direction; clicking the ALREADY-ACTIVE
field resets sort to `{recent, desc}`. There is no "no sort" state (a list is
always ordered), so "undo" means fall back to the default order. Clicking Recent
while already default is a harmless no-op. The caret still owns direction. Pure +
unit-tested.

**R4.2-rev — Selected patterns shown as removable ✕ pills.** "N selected" hid
*which* patterns were filtering. The `Choose patterns ▾` / `N selected ▾` trigger
stays (so the dropdown always shows something), and the selected patterns now
render as blue pills next to it, each with an inline ✕ that removes just that
pattern. They wrap to new lines in the narrow panel (no cap — visibility is the
point) and render in canonical facet order so their position is stable as you
toggle.

**R4.3-rev (bug) — Inline ↗ floated right when the title wrapped.** The list-row
title + ↗ were a `flex items-center` pair, so a two-line title vertically centered
the icon and detached it from the text. Fixed by rendering the ↗ as INLINE flow
inside the title span (`align-middle`, `ml-1`) so it sits right after the last
word regardless of wrapping. (The row container moved to `items-start` so the
difficulty tag aligns to the first line.)

**R4.4-rev (bug) — Report "Save to My Progress" button reappeared after
navigating away.** NOT part of this screen's scope originally, but a real defect:
the saved state was ephemeral React state (`savedReportIds: Set<string>` in
`App.tsx`) that was never persisted. The report card itself IS persisted (in
`ProgressState.contentHistory` via `appendContent`), so on navigating away + back
the card was restored but its saved state reset → the Save button re-appeared for
an already-saved report. **Fix:** move the saved flag ONTO the card's persisted
metadata — new `ContentMetadata.savedToProgress`. `handleSaveToProgress` now calls
a new `markReportSaved(problemUrl, contentId)` (progress-tracker) to set the flag
in stored `contentHistory`, and updates in-memory content so the button flips
immediately. `ContentDisplay` derives `isSaved` from `item.metadata.savedToProgress`
(the `savedReportIds` prop/state is removed entirely). Because the flag rides the
same persisted `contentHistory` the card does, the "✓ Saved" state now survives
navigation for free — keyed to the exact card, no slug-matching ambiguity.

**Files touched by REVISION 4:** `progress-list-controls.ts` (+`selectOrResetSort`,
rename from `selectSort`), its test; `ProgressView.tsx` (pattern pills, inline-icon
wrap, sort handler); `types/models.ts` (+`savedToProgress`); `progress-tracker.ts`
(+`markReportSaved`); `App.tsx` + `ContentDisplay.tsx` (derive saved state from
metadata, drop `savedReportIds`). Still no network/permission change; the save-bug
fix uses the existing per-problem progress storage.

---

## 1. What's there today (verified against the branch)

From the deep read of `src/components/ProgressView.tsx` and
`src/types/models.ts`:

- `ProgressView` loads the index in a `useEffect`, sorts it **once** by
  `lastUpdatedAt` desc, and stores it in `index` state:
  ```ts
  const idx = await getProgressIndex();
  idx.sort((a, b) => b.lastUpdatedAt - a.lastUpdatedAt);
  setIndex(idx);
  ```
  The list body then renders `index.map(...)` directly — there is **no search,
  sort, or filter layer** between state and render.
- Each list row is a single `<button onClick={() => openRecord(e.slug)}>` whose
  whole surface opens the detail view. Inside it: title, difficulty, `PatternChips`,
  "Updated {timeAgo}", "View →".
- `RecordDetail` shows title, difficulty, `PatternChips`, "Updated …", the
  attempts timeline, the note, and Copy/Delete. It does **not** render the `url`.
- `ProblemIndexEntry` already carries everything the three controls need:
  `slug, url, title, difficulty, patterns, attemptCount, lastUpdatedAt`. The
  full `ProblemRecord` also carries `url`. **No field needs to be added** — this
  is the core finding that keeps the spec read-only.
- The toolbar (Copy all / Download ▾ / Import) and the local-first note and
  import-feedback banner all sit **above** the scrollable list body and are gated
  on `!loading && !selected`. The controls we add belong in that same band so
  they share the "list screen only" gating and never appear in the detail view.
- Tests run under vitest `environment: 'node'`, `include:
  'src/**/*.{test,spec}.ts'`, `globals: false`. The established DOM-free pattern
  is a pure `.ts` data/logic module (e.g. `src/components/discovery-prompts.ts`)
  with a colocated `__tests__/*.test.ts` importing `{ describe, it, expect }`
  from `vitest`. We follow that pattern exactly.

---

## 2. Design overview

The whole feature is one principle: **keep `index` as the immutable loaded data,
derive the visible list from it.** We never mutate or re-sort `index` in place
(today's `.sort()` on load is the ONE sort and it stays as the data's natural
order — see §6 on preserving the default). Instead:

```
index (immutable, load order)
   │
   ▼
filterSortProblems(index, controls)   ← NEW pure function (testable, env=node)
   │
   ▼
visible  →  rendered list / "no matches" empty state
```

`controls` is the transient UI state (search query, sort key, difficulty filter,
pattern filter) held in `ProgressView` via `useState` and recomputed with
`useMemo` on every keystroke/toggle. Nothing is persisted (R1.6) and nothing
touches storage or the network (R4.2).

### New files

| File | What |
|---|---|
| `src/components/progress-list-controls.ts` | The PURE logic: types + `filterSortProblems()` + `collectPatternFacets()` + the LeetCode-link guard. DOM-free, unit-tested. |
| `src/components/__tests__/progress-list-controls.test.ts` | Vitest unit tests for the pure functions. |

### Changed file

| File | What |
|---|---|
| `src/components/ProgressView.tsx` | Add the controls UI + the derived `visible` list; render search box, sort/filter bar, "no matches" empty state, and the LeetCode link in both the row and the detail view. No logic beyond wiring + presentation. |

No other file changes. `models.ts`, `progress-records.ts`, `progress-analytics.ts`
are untouched.

---

## 3. The pure module — `progress-list-controls.ts`

This is where R4.3 is satisfied: the predicate/comparator live as pure functions
so they unit-test under `env=node` without rendering the component.

### 3.1 Types

```ts
import type { ProblemIndexEntry, ProblemPattern } from '../types';

export type SortKey = 'recent' | 'difficulty' | 'title';

export interface ListControls {
  /** Case-insensitive substring match against the title. Trimmed; '' = no search. */
  query: string;
  /** Difficulty filter; empty set = no difficulty filter (all pass). */
  difficulties: Set<ProblemIndexEntry['difficulty']>;
  /** Pattern filter; empty set = no pattern filter (all pass). */
  patterns: Set<ProblemPattern>;
  /** Sort order applied AFTER filter+search. */
  sort: SortKey;
}

export const DEFAULT_CONTROLS: ListControls = {
  query: '',
  difficulties: new Set(),
  patterns: new Set(),
  sort: 'recent',
};
```

**Why `recent` is the default and what it means.** `recent` reproduces today's
behavior exactly (R3.7). Because `index` arrives already sorted by `lastUpdatedAt`
desc (the load-time sort stays), `sort: 'recent'` is defined as **"preserve the
input order"** — `filterSortProblems` does NOT re-sort for `recent`, it just
returns the filtered slice in input order. That guarantees byte-for-byte parity
with today when no controls are touched, and keeps "recent" correct even if the
load-order rule ever changes, since the function trusts its input's order.

### 3.2 `filterSortProblems`

```ts
export function filterSortProblems(
  entries: ProblemIndexEntry[],
  controls: ListControls,
): ProblemIndexEntry[] {
  const q = controls.query.trim().toLowerCase();

  const filtered = entries.filter(e => {
    // R1.2 — title substring, case-insensitive.
    if (q && !e.title.toLowerCase().includes(q)) return false;
    // R3.2 — difficulty filter (OR within the category).
    if (controls.difficulties.size > 0 && !controls.difficulties.has(e.difficulty)) return false;
    // R3.2 — pattern filter (OR within the category): entry matches if it has
    // ANY selected pattern. Difficulty AND pattern compose as AND across
    // categories (R3.2).
    if (controls.patterns.size > 0 && !e.patterns.some(p => controls.patterns.has(p))) return false;
    return true;
  });

  return sortEntries(filtered, controls.sort);
}
```

- **Composition (R1.5 / R3.5):** search AND difficulty AND pattern all narrow the
  set; sort orders the result. Within a category the selected values are OR'd
  (selecting Easy+Hard shows both); across categories it's AND (Easy AND Two
  Pointers). This is the conventional faceted-filter semantics and matches R3.2
  ("Multiple filters compose (AND across categories)").
- **Non-mutating:** `.filter` returns a new array; `sortEntries` sorts a copy.
  `index` is never mutated, so toggling a filter off restores the full list.

### 3.3 `sortEntries`

```ts
function sortEntries(entries: ProblemIndexEntry[], sort: SortKey): ProblemIndexEntry[] {
  if (sort === 'recent') return entries;            // preserve input (load) order — R3.7
  const copy = entries.slice();
  switch (sort) {
    case 'title':
      return copy.sort((a, b) => a.title.localeCompare(b.title)); // A–Z, R3.1
    case 'difficulty':
      return copy.sort((a, b) =>
        DIFFICULTY_RANK[a.difficulty] - DIFFICULTY_RANK[b.difficulty]
        || a.title.localeCompare(b.title));         // Easy→Hard, title as tiebreak
  }
}

const DIFFICULTY_RANK: Record<ProblemIndexEntry['difficulty'], number> =
  { Easy: 0, Medium: 1, Hard: 2 };
```

- `recent` returns the input untouched (the input is already recency-sorted) so
  the default path is a pure pass-through — zero risk of changing today's order.
- `difficulty` uses a fixed Easy→Medium→Hard rank with a title tiebreak so the
  order is stable and deterministic (important for a predictable unit test).
- `title` uses `localeCompare` for human A–Z.

### 3.4 Facets — `collectPatternFacets`

The pattern filter should only offer patterns that actually appear in the user's
records (R3.2 says "the `ProblemPattern` vocabulary present in the user's
records") — offering all 23 vocabulary values in a narrow panel would be noise.

```ts
export function collectPatternFacets(entries: ProblemIndexEntry[]): ProblemPattern[] {
  const seen = new Set<ProblemPattern>();
  for (const e of entries) for (const p of e.patterns) seen.add(p);
  // Stable, readable order: the canonical ProblemPattern declaration order.
  return PROBLEM_PATTERN_ORDER.filter(p => seen.has(p));
}
```

`PROBLEM_PATTERN_ORDER` is a local `const` array literal of the `ProblemPattern`
union in declaration order (the union is a type, so it can't be enumerated at
runtime — we mirror it as a data array in this module and a test pins that the
array stays in sync with the type by exhaustive assignment). Difficulty facets
are the fixed `['Easy','Medium','Hard']`, always shown.

### 3.5 The LeetCode-link guard — `leetcodeHref`

R2.3/R2.4: use the stored `url` as-is; hide the affordance if it's missing/empty.

```ts
export function leetcodeHref(url: string | undefined | null): string | null {
  const u = (url ?? '').trim();
  return u.length > 0 ? u : null;
}
```

A `null` return means "render no link" (R2.4). We deliberately do NOT reconstruct
from slug (R2.3) and do NOT validate/normalize the URL here — the importer already
validates `url` against the slug on the way in (per the export-import spec), so the
stored value is the source of truth. Keeping this a one-liner keeps the component
dumb: `const href = leetcodeHref(e.url); {href && <a .../>}`.

---

## 4. The UI in `ProgressView.tsx`

### 4.1 State

```ts
const [controls, setControls] = useState<ListControls>(DEFAULT_CONTROLS);
const patternFacets = useMemo(() => collectPatternFacets(index), [index]);
const visible = useMemo(() => filterSortProblems(index, controls), [index, controls]);
```

`controls.query`, `controls.difficulties`, and `controls.patterns` are transient
(reset on remount / reopen → R1.6). Only `controls.sort` is seeded from and
written back to storage (§4.6). `visible` is what the list body maps over instead
of `index`. The insights panel keeps reading the **unfiltered** `records`/
`insights` (scope guard: we do not touch analytics; the insights summary describes
the whole dataset, not the filtered view).

### 4.2 Layout — a compact controls band (R3.6)

Inserted in the existing `!loading && !selected` band, directly under the data
toolbar (Copy all / Download / Import) and above the local-first note, so it only
shows on the list screen and never in the detail view:

```
┌─────────────────────────────────────────┐
│ 🔍 [ search problems…            ]  (✕)   │   ← R1 search (clear ✕ when non-empty)
├─────────────────────────────────────────┤
│ Sort:  (Recent)(Difficulty)(Title)        │   ← segmented pills, one active (radio)
│ Difficulty:  E  M  H                      │   ← toggle pills (OR within category)
│ Pattern:  [Two Pointers][Hash Map]…       │   ← toggle pills, only patterns present
│                             (Clear all)   │   ← R3.4 reset, shown only when active
└─────────────────────────────────────────┘
```

(`Clear all` resets search + difficulty + pattern; it does NOT reset the persisted
sort — sort is a durable preference, so "clear filters" leaving the chosen sort in
place is the expected behavior.)

Concretely:
- **Search (R1.1–R1.4):** a single text `<input>` bound to `controls.query`,
  updating on `onChange` (live). A small clear ✕ appears inside the field when
  `query` is non-empty. `type="search"`, `aria-label="Search saved problems"`.
- **Sort (R3.1) — segmented pills (not a native select):** three toggle-pills on
  their own short row labelled `Sort:` — **Recent** (default) · **Difficulty** ·
  **Title**. Exactly one is active at a time (radio semantics): clicking a pill
  sets `controls.sort`. The active pill is filled (the shared blue accent),
  inactive pills are bordered/faint — the same pill vocabulary as the difficulty
  and pattern filters, so the whole band reads as one control group. Implemented
  as a small `role="radiogroup"` with each pill a `role="radio"` /
  `aria-checked` button, so it's keyboard- and screen-reader-correct. No native
  `<select>` and no popup — the closed/open-list theming problem a select brings
  is avoided entirely, and three pills are more compact than a select + its
  dropdown in a narrow panel.
- **Difficulty filter (R3.2):** three toggle pills E / M / H. Clicking toggles
  membership in `controls.difficulties`. Active pill = filled; inactive =
  bordered. Reuse the difficulty color scheme already in `difficultyColor`.
- **Pattern filter (R3.2):** toggle pills from `patternFacets` (only patterns the
  user has). Styled like the existing `PatternChips` but interactive (selected =
  solid, unselected = faint). If the user has no patterns at all, the pattern row
  is omitted.
- **Clear all (R3.4):** a small text button shown only when a transient control is
  active (`query !== '' || difficulties.size > 0 || patterns.size > 0`). Clicking
  it clears search + difficulty + pattern but **leaves `sort` untouched** (sort is
  a persisted preference, not a transient filter — resetting it on "clear filters"
  would be surprising). "What's applied" is visible because active pills are
  visually distinct and the search text sits in the box (R3.4).

All controls use the existing Tailwind token palette (neutral borders, blue
accents, `dark:` variants) so dark/light theme is respected automatically (R4.4).
Everything is `text-[10px]/[11px]` compact to fit the panel (R3.6).

### 4.3 The "no matches" empty state (R1.4)

The list body today has three branches: loading → detail → `index.length === 0`
(empty) → list. We add a fourth: when `index.length > 0` but
`visible.length === 0`, render a distinct "no problems match your filters" state
with a Clear-all affordance, rather than a blank area. The existing
`index.length === 0` "no saved progress yet" state is untouched (it means a
genuinely empty dataset, a different message).

### 4.4 The LeetCode link — list row (R2.2b) WITHOUT hijacking row click

This is the one real interaction hazard. The row is a `<button>` whose click opens
the detail; a naive nested link would either be invalid HTML (an `<a>` inside a
`<button>`) or would bubble its click into the row and also open the detail.

**Decision: render the link as a sibling, NOT a child, of the row button** — a
small two-cell flex row where the big button and a separate ↗ anchor sit
side-by-side:

```tsx
<div className="flex items-stretch gap-1">
  <button onClick={() => openRecord(e.slug)} className="flex-1 …">
    …existing row content…
  </button>
  {leetcodeHref(e.url) && (
    <a
      href={leetcodeHref(e.url)!}
      target="_blank"
      rel="noopener noreferrer"
      onClick={ev => ev.stopPropagation()}
      title="Open on LeetCode"
      aria-label={`Open ${e.title} on LeetCode`}
      className="shrink-0 px-2 flex items-center rounded-lg border … text-neutral-400 hover:text-blue-500"
    >↗</a>
  )}
</div>
```

The anchor is **outside** the button entirely, so there is no nested-interactive
HTML and no click-bubbling ambiguity: clicking the row opens detail, clicking ↗
opens LeetCode in a new tab. `stopPropagation` is belt-and-suspenders (siblings
don't bubble into each other, but it documents intent and guards against a future
wrapper). `target="_blank"` + `rel="noopener noreferrer"` per R2.1. Hidden when
`url` is missing (R2.4).

### 4.5 The LeetCode link — detail view (R2.2a, required)

In `RecordDetail`, next to the title/difficulty header, add the same ↗ anchor
(required here per R2.2). `RecordDetail` takes `record: ProblemRecord`, which has
`url`, so no new prop is needed. Same guard + `target`/`rel`.

### 4.6 Persisting the sort preference (documented R1.6/R4.2 deviation)

Per the user's decision, **only `sort` persists**; search and filters stay
transient. Mechanics follow the shipped `src/services/storage.ts` convention
(promise-wrapped `chrome.storage.local`, same shape as `saveSettings`/
`getSettings`):

- **New key:** `STORAGE_KEYS.PROGRESS_LIST_SORT = 'progress_list_sort'` — one small
  string value, one of `'recent' | 'difficulty' | 'title'`.
- **New storage helpers** in `storage.ts` (tiny, mirror the existing ones):
  ```ts
  export async function getProgressListSort(): Promise<SortKey>  // defaults 'recent'
  export async function saveProgressListSort(sort: SortKey): Promise<void>
  ```
  `getProgressListSort` returns `'recent'` when the key is absent OR holds an
  unrecognized value (fail-safe to the default — guards against a tampered/old
  value, and keeps R3.7's "default behaves like today" true on a fresh install).
  The validation is a pure `isSortKey(x): x is SortKey` guard exported from
  `progress-list-controls.ts` so it is unit-tested there, and `storage.ts` reuses
  it.
- **Wiring in `ProgressView`:**
  - The loading `useEffect` additionally reads the persisted sort and seeds
    `controls.sort` from it (so a reopen restores the chosen sort). Search/filters
    are NOT seeded — they start empty every time (R1.6).
  - A small effect writes the sort back whenever `controls.sort` changes:
    `useEffect(() => { void saveProgressListSort(controls.sort); }, [controls.sort])`.
    Only `sort` is in the dependency list, so typing in the search box or toggling
    a filter never writes to storage — exactly one write per sort change, and no
    write on mount is wasted because writing the already-current value is harmless
    and idempotent. (No debounce needed: sort changes are discrete pill clicks,
    not keystrokes.)

**Why this is a safe, bounded deviation.** It adds one enum key, no schema change
to any record, no network, no new permission (the `storage` permission already
ships). The default remains `'recent'`, so an untouched install and a reset value
both behave exactly like today (R3.7 preserved). Search + filters remaining
transient is the deliberate half of the decision: a persisted filter could
silently hide most of the list on reopen, which reads as a bug; a persisted sort
is a genuine remembered preference.

---

## 5. Requirements traceability

| Req | Where satisfied |
|---|---|
| R1.1 search box at top | §4.2 search input |
| R1.2 title, case-insensitive substring | §3.2 `q && !title.includes(q)` (both lowercased) |
| R1.3 client-side, live, no load/network | `useMemo` over in-memory `index`; no async |
| R1.4 "no matches" empty state | §4.3 fourth render branch |
| R1.5 composes with filter+sort | §3.2 single `filterSortProblems` pipeline |
| R1.6 transient, resets on reopen | §4.1 `useState`, nothing persisted |
| R2.1 new tab, noopener noreferrer | §4.4/§4.5 `target="_blank" rel="noopener noreferrer"` |
| R2.2a detail view link | §4.5 |
| R2.2b list-row link, no hijack | §4.4 sibling anchor + stopPropagation |
| R2.3 use stored url, don't reconstruct | §3.5 `leetcodeHref` passes url through |
| R2.4 hide if url missing | §3.5 returns null → `{href && …}` |
| R3.1 sort recent/difficulty/title | §3.3 `sortEntries` |
| R3.2 difficulty + pattern filter, AND across | §3.2 compose; §3.4 facets |
| R3.3 driven off index fields in memory | pure fn over `ProblemIndexEntry[]` |
| R3.4 visible + clearable | §4.2 active pills + Clear all |
| R3.5 filter+search+sort compose predictably | §3.2 pipeline order: filter → sort |
| R3.6 compact for narrow panel | §4.2 compact pills + native select, small text |
| R3.7 default == today exactly | §3.1/§3.3 `recent` = pass-through of load order; persisted-sort defaults to `'recent'` (§4.6) |
| R4.1 no regressions (detail/insights/export) | controls gated to list screen; analytics untouched |
| R4.2 no new permission/network/storage | **Partial, deliberate deviation (§4.6):** no new permission (uses the shipped `storage` perm) and no network; adds ONE small `chrome.storage.local` enum key for the persisted sort, per the user's decision. Search + filters add no storage. |
| R4.3 pure-function unit tests | §3 module + §7 tests |
| R4.4 theme + narrow layout | §4.2 existing Tailwind tokens + `dark:` |

---

## 6. Preserving today's behavior exactly (R3.7) — the risk I care most about

The one way this feature could regress is if the default view's order or contents
changed. Two guarantees prevent that:

1. The load-time `idx.sort((a,b) => b.lastUpdatedAt - a.lastUpdatedAt)` stays
   exactly as-is; `index` is still the recency-sorted array it is today.
2. `DEFAULT_CONTROLS` is `{ query:'', difficulties:∅, patterns:∅, sort:'recent' }`,
   and `filterSortProblems(index, DEFAULT_CONTROLS)` === `index` (empty query
   passes all, empty filter sets pass all, `recent` returns the input unsorted).
   A unit test pins this identity (`filterSortProblems(sample, DEFAULT_CONTROLS)`
   deep-equals `sample` in the same order).

So a user who never touches the controls sees byte-identical output to today.

---

## 7. Test plan (R4.3) — `progress-list-controls.test.ts`, env=node

Pure-function tests only (the DOM-free pattern). Minimum cases, matching the
requirements' explicit list:

- **default == identity:** `filterSortProblems(sample, DEFAULT_CONTROLS)` equals
  `sample` in order (R3.7 guard).
- **empty query:** empty/whitespace query returns all entries (R1.2/R3.7).
- **no matches:** a query matching nothing returns `[]` (drives the §4.3 empty
  state; R1.4).
- **case-insensitive substring:** `'two'` matches `'Two Sum'`; `'SUM'` matches
  `'Two Sum'` (R1.2).
- **difficulty filter:** `{Easy}` returns only Easy; `{Easy,Hard}` returns Easy +
  Hard (OR within category) (R3.2).
- **pattern filter:** `{Two Pointers}` returns only entries having it; an entry
  with multiple patterns matches if ANY selected pattern is present (R3.2).
- **composed filter + search + sort:** query + difficulty + pattern + a non-recent
  sort together produce exactly the expected narrowed, ordered list (R1.5/R3.5).
- **sort difficulty:** Easy→Medium→Hard with title tiebreak, deterministic (R3.1).
- **sort title:** A–Z via localeCompare (R3.1).
- **non-mutation:** `filterSortProblems` does not mutate the input array (ordering
  of `index` after a filtered call is unchanged) — guards the "toggle off restores
  full list" behavior.
- **facets:** `collectPatternFacets` returns only patterns present, in canonical
  order, de-duplicated (R3.2/§3.4).
- **missing-url hidden link:** `leetcodeHref('')`, `leetcodeHref(undefined)`,
  `leetcodeHref('   ')` → `null`; `leetcodeHref('https://leetcode.com/problems/two-sum/')`
  → the same string (R2.3/R2.4).
- **sort-key validation (persistence, §4.6):** `isSortKey('recent'|'difficulty'|
  'title')` → true; `isSortKey('bogus'|''|undefined)` → false. This is what makes
  `getProgressListSort` fail safe to `'recent'` on an unknown/old stored value
  (R3.7 preserved).

Build gate: `npm.cmd run build` (must compile) + `npm.cmd run test` (all green,
new tests added). Per the standing rule I then EXPLAIN and STOP — the user
eyeballs the built, reloaded extension (search filters live, ↗ opens the right
tab, filter/sort compose, default state unchanged) before any implementation
commit.

---

## 8. Alternatives considered

- **Mutate/re-sort `index` state directly** instead of a derived `visible`.
  Rejected: it couples the loaded data to the view state, makes "clear filters"
  require a reload, and risks changing the default order. A derived memo is
  simpler and makes R3.7 trivially provable.
- **Nested `<a>` inside the row `<button>`.** Rejected: invalid interactive-in-
  interactive HTML and the click-bubbling hazard the requirements explicitly warn
  about. The sibling-anchor layout (§4.4) sidesteps both.
- **Native `<select>` for sort.** Rejected (user-confirmed): the popup list is
  OS-rendered and un-themeable — wrong font/arrow/highlight and a light-mode list
  even in dark theme — so it reads as foreign in the panel. **Segmented pills**
  (§4.2) keep the whole band in one visual language, are theme-correct, and are
  more compact than select + dropdown for a 3-choice control.
- **Custom styled popup for sort** (like the Download ▾ menu). Considered as the
  alternative to pills; rejected because a 3-choice single-select doesn't justify
  an outside-click/Escape-managed popup — pills are simpler and show all three
  choices at once (better discoverability in a one-time-use control).
- **Persist everything (search + filters + sort).** Rejected (user-confirmed):
  a persisted search/filter can silently hide most of the list on reopen and read
  as a bug. We persist only the durable `sort` preference and keep search +
  filters transient — the conventional split (§4.6).
- **Offer the full 23-value `ProblemPattern` vocabulary as filter pills.**
  Rejected: noise in a narrow panel; `collectPatternFacets` restricts to patterns
  the user actually has, per R3.2's wording.
- **Persist the controls** (sort/filter) across sessions. Deferred: R1.6 says
  transient is the default; persistence would mean a storage write, which this
  read-only spec avoids. Noted as a possible future enhancement, not built.

---

## 9. Out of scope (restating the guards)

- Insights/analytics (`computeInsights`, the insights panel content) — SIBLING
  spec `leetsage-progress-insights-overhaul`. The panel keeps describing the full
  dataset; we do not filter it.
- Any data-model / schema / record-shape change — none; read-only.
- Submission verification / Phase D — deferred project-wide.
- Persisted SEARCH and FILTER state — intentionally transient (R1.6). Only the
  `sort` preference persists (§4.6, user decision); persisting search/filters is a
  deliberately-rejected option, not a pending task.
