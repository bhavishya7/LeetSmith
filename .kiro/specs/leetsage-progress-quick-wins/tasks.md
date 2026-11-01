# Progress Screen Quick Wins — Tasks

> **Phase: tasks — awaiting sign-off.** Written AFTER the deep code read +
> signed-off [`design.md`](./design.md). Per `.kiro/steering/workflow.md` this
> session pauses for the user's sign-off on tasks before implementing, builds
> with `npm.cmd run build` + `npm.cmd run test`, then **explains and STOPs for
> review before committing** (and because R1/R2/R3 are visual/UX, the user
> eyeballs the built, reloaded extension before any implementation commit).

Legend: `[ ]` not started · `[~]` in progress · `[x]` done.

> **REVISION 2 tasks (post-eyeball UX overhaul)** are in §6 at the bottom. Tasks
> 1–5 below were completed in the first build (functionally correct, 562 tests
> green); §6 captures the layout + polish pass from the user's visual review.

---

## 1 — Pure logic module (DOM-free, the testable core)

- [ ] **1.1 Create `src/components/progress-list-controls.ts`.**
  - Export `type SortKey = 'recent' | 'difficulty' | 'title'`.
  - Export `interface ListControls { query; difficulties: Set<Difficulty>;
    patterns: Set<ProblemPattern>; sort: SortKey }` and
    `const DEFAULT_CONTROLS` (`''`, empty sets, `'recent'`).
  - Export `const SORT_OPTIONS: { key: SortKey; label: string }[]`
    (`Recent` / `Difficulty` / `Title`) so the UI renders pills from data.
  - Export `function isSortKey(x: unknown): x is SortKey` (used by storage to
    fail-safe to `'recent'`).
  - Implement `filterSortProblems(entries, controls)`: trim+lowercase query →
    title substring (R1.2); difficulty OR-within / pattern OR-within; AND across
    categories (R3.2); then `sortEntries`. Non-mutating (filter returns new array;
    sort on a `.slice()` copy).
  - Implement `sortEntries(entries, sort)`: `recent` → return input unchanged
    (R3.7 pass-through); `title` → `localeCompare`; `difficulty` →
    Easy→Medium→Hard rank with title tiebreak (`DIFFICULTY_RANK`).
  - Implement `collectPatternFacets(entries)`: patterns present, de-duped, in
    canonical declaration order via a local `PROBLEM_PATTERN_ORDER` array.
  - Add an exhaustive `satisfies`/assignment check pinning `PROBLEM_PATTERN_ORDER`
    to the `ProblemPattern` union so a future pattern added to the type forces an
    update here (compile-time guard).
  - Implement `leetcodeHref(url): string | null` — trimmed non-empty passthrough,
    else `null` (R2.3/R2.4). No slug reconstruction, no normalization.
  - File header comment: what it is, why pure/DOM-free, the spec reference.

- [ ] **1.2 Create `src/components/__tests__/progress-list-controls.test.ts`.**
  Cover (design §7):
  - `filterSortProblems(sample, DEFAULT_CONTROLS)` deep-equals `sample` in order
    (R3.7 identity).
  - empty/whitespace query → all entries.
  - no-match query → `[]`.
  - case-insensitive substring (`'two'`, `'SUM'` both match `'Two Sum'`).
  - difficulty filter: `{Easy}`, and `{Easy,Hard}` (OR within category).
  - pattern filter: single pattern; multi-pattern entry matches on ANY selected.
  - composed filter + search + non-recent sort → exact expected narrowed+ordered.
  - sort `difficulty` (Easy→Medium→Hard, title tiebreak) deterministic.
  - sort `title` A–Z.
  - non-mutation: input array order unchanged after a filtered call.
  - `collectPatternFacets` returns only-present, de-duped, canonical order.
  - `leetcodeHref` null cases (`''`, `undefined`, `'   '`) + passthrough.
  - `isSortKey` true for the three keys, false for `'bogus'`/`''`/`undefined`.

## 2 — Sort persistence in storage (the documented R4.2 deviation)

- [ ] **2.1 Add the storage helpers in `src/services/storage.ts`.**
  - Add `PROGRESS_LIST_SORT: 'progress_list_sort'` to `STORAGE_KEYS`.
  - `getProgressListSort(): Promise<SortKey>` — promise-wrapped
    `chrome.storage.local.get`, returns stored value if `isSortKey`, else
    `'recent'` (fail-safe). Import `isSortKey`/`SortKey` from
    `progress-list-controls.ts`.
  - `saveProgressListSort(sort: SortKey): Promise<void>` — promise-wrapped
    `chrome.storage.local.set`, same error-handling shape as `saveSettings`.
  - Keep the existing promise/`chrome.runtime.lastError` convention exactly.

## 3 — Wire the controls into `ProgressView.tsx`

- [ ] **3.1 State + derived list.**
  - `const [controls, setControls] = useState<ListControls>(DEFAULT_CONTROLS)`.
  - `const patternFacets = useMemo(() => collectPatternFacets(index), [index])`.
  - `const visible = useMemo(() => filterSortProblems(index, controls), [index, controls])`.
  - In the loading `useEffect`, after setting `index`, also
    `const sort = await getProgressListSort(); setControls(c => ({ ...c, sort }))`.
    Do NOT seed query/difficulties/patterns (stay transient, R1.6).
  - Add `useEffect(() => { void saveProgressListSort(controls.sort); }, [controls.sort])`.

- [ ] **3.2 Controls band UI** (in the `!loading && !selected` region, directly
  under the data toolbar, above the local-first note — so it's list-screen only):
  - Search `<input type="search">` bound to `controls.query`, live `onChange`,
    `aria-label="Search saved problems"`, inline clear ✕ when non-empty.
  - Sort segmented pills: `role="radiogroup" aria-label="Sort"`, each pill a
    `role="radio"` button with `aria-checked`, rendered from `SORT_OPTIONS`;
    click sets `controls.sort`. Active = filled accent, inactive = bordered/faint.
  - Difficulty toggle pills E / M / H: toggle membership in
    `controls.difficulties`; active filled, inactive bordered; reuse
    `difficultyColor` hues.
  - Pattern toggle pills from `patternFacets` (styled like `PatternChips` but
    interactive; selected solid / unselected faint). Omit the whole pattern row
    when `patternFacets.length === 0`.
  - `Clear all` text button: shown only when `query !== '' ||
    difficulties.size > 0 || patterns.size > 0`; resets those three, leaves
    `sort` as-is.
  - Compact sizing (`text-[10px]/[11px]`, tight gaps) + existing Tailwind tokens
    with `dark:` variants (R3.6/R4.4).

- [ ] **3.3 Render `visible` + the "no matches" empty state.**
  - List body maps `visible` (not `index`).
  - Add a 4th render branch: `index.length > 0 && visible.length === 0` → a
    distinct "No problems match your filters" state with a `Clear all` affordance
    (R1.4). Leave the existing `index.length === 0` "no saved progress yet" state
    unchanged.

- [ ] **3.4 List-row LeetCode link (R2.2b, no row-click hijack).**
  - Restructure each row into a `flex` with the existing `<button>` as `flex-1`
    and a SIBLING `<a>` (NOT nested): `href={leetcodeHref(e.url)!}`
    `target="_blank" rel="noopener noreferrer"`, `onClick` stopPropagation, ↗
    glyph, `aria-label={`Open ${e.title} on LeetCode`}`, `title="Open on LeetCode"`.
  - Render the anchor only when `leetcodeHref(e.url)` is non-null (R2.4).
  - Verify the row button still opens the detail and the ↗ does not.

- [ ] **3.5 Detail-view LeetCode link (R2.2a, required).**
  - In `RecordDetail`, add the same ↗ anchor next to the title/difficulty header,
    using `record.url` via `leetcodeHref`; same guard + `target`/`rel`.

## 4 — Verify (build + test gate)

- [ ] **4.1 `npm.cmd run build`** — must compile (`tsc -b && vite build`,
  "built in <N>ms"). Fix any TS/type errors (esp. the `ProblemPattern` exhaustive
  guard and `Set` typing).
- [ ] **4.2 `npm.cmd run test`** — all green, including the new
  `progress-list-controls.test.ts`. If the terminal garbles output, write to a
  temp file, read it, delete the temp file.
- [ ] **4.3** Confirm no change to analytics/insights/export/import/detail paths
  (scope guard): `computeInsights`, `progress-analytics.ts`, `progress-io.ts`,
  `progress-records.ts`, `models.ts` untouched; only `progress-list-controls.ts`
  (new), its test (new), `storage.ts` (+2 helpers/1 key), and `ProgressView.tsx`
  changed.

## 5 — Explain & STOP (hard gate — no autonomous commit)

- [ ] **5.1** Explain what/why/how and STOP. Do NOT commit the implementation,
  do NOT run the historian.
- [ ] **5.2** Because R1/R2/R3 are visual/UX, the user reloads the unpacked
  extension at `chrome://extensions` and eyeballs: search filters live; the ↗ link
  opens the correct LeetCode tab; sort/difficulty/pattern compose; `Clear all`
  resets filters but keeps sort; default state (no search/filter, recency) matches
  today; sort choice survives a panel reopen; dark/light theme looks right.
- [ ] **5.3** Only after the user approves: commit (logical groups, detailed
  message via `git commit -F` temp file), update `.kiro/specs/README.md` (add the
  two progress specs + the optimize-nudge stub to the index), and run the
  project-historian — each when the user triggers it.

---

## Change surface (at a glance)

| File | Change |
|---|---|
| `src/components/progress-list-controls.ts` | **new** — pure logic + types |
| `src/components/__tests__/progress-list-controls.test.ts` | **new** — unit tests |
| `src/services/storage.ts` | **edit** — +1 key, +`getProgressListSort`/`saveProgressListSort` |
| `src/components/ProgressView.tsx` | **edit** — controls band, derived `visible`, no-match state, ↗ links, sort seed/persist effects |

No other files. No schema/permission/network change (the one new storage key uses
the already-granted `storage` permission).

---

## 6 — REVISION 2: post-eyeball UX overhaul (design §REVISION 2)

- [ ] **6.1 New `src/components/icons.tsx`** — inline SVG icon components (no
  library; follows the `UsageReservoir.tsx` precedent). `currentColor` fill/stroke
  so theme works; `aria-hidden` (labels live on the buttons). Exports:
  - `DownloadIcon` — arrow descending into an open tray/bracket.
  - `ImportIcon` — mirror: arrow ascending out of the tray.
  - `CopyIcon` — two overlapping sheets.
  - `ExternalLinkIcon` — ↗ box-with-arrow for the LeetCode link.
  - Each takes an optional `size`/`className`.

- [ ] **6.2 Search stays title-only** (R2.1) — no code change to the predicate;
  confirm the existing title-only `filterSortProblems` is kept. (Documented
  decision, not a task.)

- [ ] **6.3 Pattern filter → multi-select dropdown** (R2.2). In `ListControlsBar`:
  - Replace the pattern pill row with a `Pattern ▾` trigger button (shows
    `Pattern` or `Pattern (N)` when `patterns.size > 0`).
  - Dropdown menu reusing the Download-menu pattern: `role="menu"`, outside-click
    close, Escape close (a local `useEffect` mirroring the existing `downloadOpen`
    handler, or a small shared hook — keep it local to avoid over-engineering).
  - Menu items are checkbox rows (one per `patternFacets` entry) toggling
    membership in `controls.patterns`.
  - Omit the whole control when `patternFacets.length === 0`.
  - Keep Sort (segmented radio pills) and Difficulty (toggle pills) inline.

- [ ] **6.4 Difficulty pills carry E/M/H colors** (R2.3) — selected Easy green /
  Medium amber / Hard red via the existing `difficultyColor` hues (fill + text);
  unselected stays neutral-bordered. Generalize `FilterPill` with an optional
  `tone` or pass explicit classes for the difficulty variant.

- [ ] **6.5 Bigger section labels** (R2.4) — "Sort:" / "Difficulty:" / "Pattern:"
  to `text-[11px]`/`text-xs`, medium weight, deeper neutral color.

- [ ] **6.6 LeetCode link → real inline `<a>` by the title (option B)** (R2.5).
  Restructure the list row:
  - From a single `<button>` to a `<div role="button" tabIndex={0}>` with
    `onClick` + `onKeyDown` (Enter/Space) → `openRecord(e.slug)`; keep the hover/
    focus styling it has today.
  - Put the `<a>` (the `ExternalLinkIcon`) INLINE immediately after the title
    text, `target="_blank" rel="noopener noreferrer"`, `onClick` +`onKeyDown`
    `stopPropagation` so it never triggers the row's open-detail. Guard with
    `leetcodeHref(e.url)` (hidden when missing, R2.4).
  - Remove the old sibling bordered ↗ box.
  - Update the `LeetCodeLink` component to render `ExternalLinkIcon` and accept the
    inline styling; reuse it for the detail-view header link (§4.5 placement kept).

- [ ] **6.7 Data actions → header icon buttons** (R2.6/R2.7). In the title row:
  - Remove the `(31)` count span.
  - Add `⧉ Copy all` / `⬇▾ Download` / `⬆ Import` as icon-only buttons (SVG icons
    from 6.1) with the existing `title` tooltips + `aria-label`s; Download keeps
    its ▾ menu behavior and ref.
  - Cluster the three left of the `✕`, with a clear gap before `✕`.
  - Delete the old toolbar band (the `!loading && !selected` toolbar `<div>`) and
    the always-mounted file input moves into the header (stays mounted/hidden).
  - The `copiedAll` / `downloadOpen` state + outside-click effect stay; just
    re-homed into the header.

- [ ] **6.8 Fixed vs. scrolling layout** (R2.8). Reorder the component body:
  - FIXED (outside the scroll container): header row (6.7) + `ListControlsBar`.
  - SCROLL container: Insights card (top) → problem rows → the "stored locally…"
    disclaimer (LAST). Move the disclaimer `<p>` to the end of the scroll content.
  - Keep the import-feedback banner near the top of the scroll region (transient).
  - Verify the controls bar + header don't scroll; the list region does.

- [ ] **6.9 Verify** — `npm.cmd run build` compiles; `npm.cmd run test` all green
  (the pure-logic tests are unaffected; no predicate change). Confirm scope guard
  still holds (icons.tsx new; ProgressView.tsx edited; no analytics/io/model/
  storage-logic change beyond what REVISION 1 already added).

- [ ] **6.10 Explain & STOP** — per the hard gate, present the rebuilt UI and let
  the user eyeball the reloaded extension (header icons + tooltips; pattern
  dropdown opens/closes/counts; difficulty colors; inline ↗ opens LeetCode while
  the box opens detail; fixed header/controls with scrolling insights→rows→
  disclaimer) BEFORE any commit. Do not commit or run the historian unprompted.

---

## 7 — REVISION 3: bidirectional sort + sort/filter split (design §REVISION 3)

- [x] **7.1 Pure logic: bidirectional sort.** `Sort = {key, direction}`;
  `SORT_DEFAULT_DIR`; `DEFAULT_SORT = {recent, desc}`; `DEFAULT_CONTROLS.sort`
  updated. `sortEntries` honors direction (negated comparator + flipped title
  tiebreak); `{recent,desc}` stays the pass-through (R3.7). New pure helpers
  `selectSort`, `toggleSortDirection`, `normalizeSort` (legacy bare-string +
  junk → fail-safe). `SORT_OPTIONS` label `title`→"A–Z".
- [x] **7.2 Storage:** `getProgressListSort`/`saveProgressListSort` now carry the
  `Sort` object; `getProgressListSort` uses `normalizeSort` (migrates old bare
  string, fails safe).
- [x] **7.3 UI: `SortSplitPill`** — two sibling buttons (label selects, caret
  flips) styled as one pill; active shows ▲/▼. Wired via `onSelectSort` /
  `onToggleSortDir`.
- [x] **7.4 UI: difficulty colored at rest** — `PILL_REST_TONE` gives E/M/H
  colored text unselected; full pill lights up selected.
- [x] **7.5 UI: sort/filter visual split** — divider between the Sort row and the
  Difficulty/Pattern rows; pattern trigger relabeled ("Choose patterns" /
  "N selected").
- [x] **7.6 Persist effect** keyed on `controls.sort.key`+`.direction` (churn-free;
  explicit eslint-disable for the intentional dependency set).
- [x] **7.7 Tests** — both directions for every field, `selectSort`,
  `toggleSortDirection` (active flip + inactive-activates-opposite),
  `normalizeSort` (legacy string, valid object, junk fail-safe). `npm.cmd run
  test` 562 → **572**.
- [x] **7.8 Verify** — build clean, lint 0 errors (2 pre-existing/intentional
  warnings), 572 tests green.
- [ ] **7.9 Explain & STOP** — user eyeballs the reloaded extension: bidirectional
  sort (label selects / caret flips, caret direction visible), difficulty colored
  at rest + lit when selected, sort/filter zones visually separated, pattern
  dropdown relabeled. No commit / historian until the user triggers it.

---

## 8 — REVISION 4: sort-undo, pattern pills, wrap fix, save-persistence bug (design §REVISION 4)

- [x] **8.1 Sort undo:** `selectSort` → `selectOrResetSort(current, key)` — active
  field re-click resets to `{recent, desc}`; inactive selects at default. Pure +
  tests updated (inactive-select, active-reset, default no-op).
- [x] **8.2 Pattern pills:** selected patterns render as removable ✕ pills next to
  the `N selected ▾` trigger, wrap in the narrow panel, canonical order.
- [x] **8.3 Inline-icon wrap fix:** list-row ↗ is inline flow inside the title span
  (`align-middle`), sits after the last word when the title wraps; row container
  `items-start`.
- [x] **8.4 Save-persistence bug:** `ContentMetadata.savedToProgress` added;
  `markReportSaved(problemUrl, contentId)` persists it onto the stored card;
  `handleSaveToProgress` persists + updates in-memory; `ContentDisplay` derives
  `isSaved` from `item.metadata.savedToProgress`; `savedReportIds` state/prop
  removed. Saved state now survives navigation (rides `contentHistory`).
- [ ] **8.5 Build + test (USER-RUN — credits):** the user builds `dist/`
  themselves. To verify locally run: `npm.cmd run build` (must compile),
  `npm.cmd run test` (all green — the sort-helper tests were updated for
  `selectOrResetSort`), `npm.cmd run lint` (expect 0 errors; 1 pre-existing
  `App.tsx` warning). Then reload the unpacked extension.
- [ ] **8.6 Eyeball:** active-pill click resets sort; pattern ✕ pills remove
  individually + wrap; ↗ stays next to the title text on wrap; generate+save a
  report, navigate to another problem and back → the report still shows "✓ Saved"
  (button does NOT reappear).
