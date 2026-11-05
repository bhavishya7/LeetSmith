import React, { useEffect, useState, useMemo, useRef } from 'react';
import type { ProblemIndexEntry, ProblemRecord, ProblemPattern } from '../types';
import {
  getProgressIndex, getRecord, deleteRecord, getAllRecords, writeImportedRecords,
} from '../services/progress-records';
import { getProgressListSort, saveProgressListSort } from '../services/storage';
import { computeInsights } from '../services/progress-analytics';
import type { ProgressInsights } from '../services/progress-analytics';
import {
  buildProgressReportMarkdown, serializeProgressExport, parseImport, mergeRecords,
} from '../services/progress-io';
import {
  filterSortProblems, collectPatternFacets, leetcodeHref,
  selectOrResetSort, toggleSortDirection,
  DEFAULT_CONTROLS, SORT_OPTIONS,
  type ListControls, type SortKey,
} from './progress-list-controls';
import { DownloadIcon, ImportIcon, CopyIcon, ExternalLinkIcon } from './icons';

interface ProgressViewProps { onClose: () => void; }

const difficultyColor: Record<string, string> = {
  Easy: 'text-green-500', Medium: 'text-yellow-500', Hard: 'text-red-500',
};

/**
 * Returns a real language label, or '' for values we shouldn't show — Monaco's
 * "plaintext"/"unknown"/empty are not the user's actual language and reading
 * them as one is misleading.
 */
function displayLanguage(lang?: string): string {
  if (!lang) return '';
  const l = lang.trim().toLowerCase();
  if (l === '' || l === 'plaintext' || l === 'unknown') return '';
  return lang.trim();
}

function timeAgo(ms: number): string {
  const days = Math.floor((Date.now() - ms) / (24 * 60 * 60 * 1000));
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

const PatternChips: React.FC<{ patterns: string[] }> = ({ patterns }) => (
  <div className="flex flex-wrap gap-1">
    {patterns.map(p => (
      <span key={p} className="text-[10px] px-1.5 py-0.5 rounded-full bg-blue-500/15 text-blue-600 dark:text-blue-300">{p}</span>
    ))}
  </div>
);

/**
 * A small "open on LeetCode" ↗ link (R2). Renders nothing when the record has no
 * usable url (R2.4) — `leetcodeHref` returns null for missing/empty. Opens in a
 * new tab with `rel="noopener noreferrer"` (R2.1); the stored url is used as-is
 * (R2.3). It is a REAL `<a>` rendered INLINE next to the title (design §R2.5,
 * option B) so it keeps genuine-link affordances (middle-click, copy address);
 * `stopPropagation` on click AND keydown stops it from triggering the enclosing
 * row's open-detail handler. Uses the inline SVG `ExternalLinkIcon` (R2.7).
 */
const LeetCodeLink: React.FC<{ url: string | undefined; title: string; className?: string; iconSize?: number }> = ({ url, title, className, iconSize }) => {
  const href = leetcodeHref(url);
  if (!href) return null;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      title="Open on LeetCode"
      aria-label={`Open ${title} on LeetCode`}
      className={`inline text-neutral-400 hover:text-blue-500 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/50 rounded ${className ?? ''}`}
    >
      {/* `inline` anchor + the icon aligned to the text's optical middle via a
          small em-based baseline nudge — robust whether the title is one line or
          wraps (an inline-flex box sat slightly below the text baseline). */}
      <ExternalLinkIcon size={iconSize} className="inline align-[-0.15em]" />
    </a>
  );
};

/**
 * Active-state classes per tone. `blue` is the default (sort + pattern); the
 * difficulty tones carry the Easy/Medium/Hard color associations (design §R2.3)
 * so a selected difficulty is instantly scannable and matches the per-row labels.
 */
const PILL_ACTIVE_TONE = {
  blue: 'border-blue-500/50 bg-blue-500/15 text-blue-600 dark:text-blue-300',
  green: 'border-green-500/50 bg-green-500/15 text-green-600 dark:text-green-400',
  amber: 'border-yellow-500/50 bg-yellow-500/15 text-yellow-600 dark:text-yellow-400',
  red: 'border-red-500/50 bg-red-500/15 text-red-600 dark:text-red-400',
} as const;
type PillTone = keyof typeof PILL_ACTIVE_TONE;

/**
 * Resting (unselected) classes per tone. `blue` reads as a neutral control at
 * rest; the difficulty tones keep their color in the TEXT even when unselected
 * (design §R2.3 revision) so Easy/Medium/Hard are scannable like the row tags,
 * then the whole pill lights up (PILL_ACTIVE_TONE) when selected.
 */
const PILL_REST_TONE = {
  blue: 'border-neutral-200 dark:border-neutral-700 text-neutral-500 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800',
  green: 'border-neutral-200 dark:border-neutral-700 text-green-600 dark:text-green-400 hover:bg-neutral-100 dark:hover:bg-neutral-800',
  amber: 'border-neutral-200 dark:border-neutral-700 text-yellow-600 dark:text-yellow-400 hover:bg-neutral-100 dark:hover:bg-neutral-800',
  red: 'border-neutral-200 dark:border-neutral-700 text-red-600 dark:text-red-400 hover:bg-neutral-100 dark:hover:bg-neutral-800',
} as const;

/** A compact pill toggle used by the difficulty filter (R3.2). */
const FilterPill: React.FC<{
  label: string;
  active: boolean;
  onClick: () => void;
  title?: string;
  tone?: PillTone;
}> = ({ label, active, onClick, title, tone = 'blue' }) => (
  <button
    type="button"
    onClick={onClick}
    aria-pressed={active}
    title={title}
    className={`px-2 py-0.5 rounded-full text-[11px] font-medium border transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/50
      ${active ? PILL_ACTIVE_TONE[tone] : PILL_REST_TONE[tone]}`}
  >
    {label}
  </button>
);

const DIFFICULTIES: ProblemIndexEntry['difficulty'][] = ['Easy', 'Medium', 'Hard'];
const DIFFICULTY_TONE: Record<ProblemIndexEntry['difficulty'], PillTone> = {
  Easy: 'green', Medium: 'amber', Hard: 'red',
};

/**
 * One sort field as a split pill with TWO sibling hit areas (design §R2 — sort
 * revision): the LABEL selects the field at its natural default direction; the
 * CARET flips/activates the direction. Two separate <button>s styled to read as
 * one connected pill (nesting interactive elements would be invalid HTML).
 */
const SortSplitPill: React.FC<{
  label: string;
  active: boolean;
  direction: 'asc' | 'desc';
  onSelect: () => void;
  onToggleDirection: () => void;
}> = ({ label, active, direction, onSelect, onToggleDirection }) => (
  <span
    className={`inline-flex items-stretch rounded-full border overflow-hidden text-[11px] font-medium transition-colors
      ${active
        ? 'border-blue-500/50 bg-blue-500/15 text-blue-600 dark:text-blue-300'
        : 'border-neutral-200 dark:border-neutral-700 text-neutral-500 dark:text-neutral-400'}`}
  >
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      title={`Sort by ${label}`}
      className="pl-2 pr-1 py-0.5 hover:bg-black/5 dark:hover:bg-white/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/50"
    >
      {label}
    </button>
    <button
      type="button"
      onClick={onToggleDirection}
      title={active
        ? `Direction: ${direction === 'asc' ? 'ascending' : 'descending'} (click to flip)`
        : `Sort by ${label}, ${direction === 'asc' ? 'ascending' : 'descending'}`}
      aria-label={`Toggle ${label} sort direction`}
      className="pr-2 pl-1 py-0.5 flex items-center border-l border-black/10 dark:border-white/10 hover:bg-black/5 dark:hover:bg-white/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/50"
    >
      <span aria-hidden="true" className={`text-[9px] ${active ? 'opacity-90' : 'opacity-40'}`}>
        {direction === 'asc' ? '▲' : '▼'}
      </span>
    </button>
  </span>
);

/**
 * The search + filter + sort controls band (R1/R3). Compact for the narrow panel
 * (R3.6); respects the dark/light theme via the existing Tailwind tokens (R4.4).
 * Pure presentation + callbacks — all the actual filtering lives in the pure
 * `filterSortProblems` (R4.3). Shown on the list screen only (the caller gates
 * it on `!loading && !selected`).
 */
const ListControlsBar: React.FC<{
  controls: ListControls;
  patternFacets: ProblemPattern[];
  onChange: (next: ListControls) => void;
}> = ({ controls, patternFacets, onChange }) => {
  const hasActiveFilters =
    controls.query !== '' || controls.difficulties.size > 0 || controls.patterns.size > 0;

  const [patternOpen, setPatternOpen] = useState(false);
  const patternMenuRef = useRef<HTMLDivElement>(null);

  // Close the pattern menu on an outside click / Escape (mirrors the Download
  // menu pattern already used in this file).
  useEffect(() => {
    if (!patternOpen) return;
    const onClick = (e: MouseEvent) => {
      if (patternMenuRef.current && !patternMenuRef.current.contains(e.target as Node)) {
        setPatternOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPatternOpen(false); };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [patternOpen]);

  const onSelectSort = (key: SortKey) =>
    onChange({ ...controls, sort: selectOrResetSort(controls.sort, key) });
  const onToggleSortDir = (key: SortKey) =>
    onChange({ ...controls, sort: toggleSortDirection(controls.sort, key) });

  const toggleDifficulty = (d: ProblemIndexEntry['difficulty']) => {
    const next = new Set(controls.difficulties);
    if (next.has(d)) next.delete(d); else next.add(d);
    onChange({ ...controls, difficulties: next });
  };

  const togglePattern = (p: ProblemPattern) => {
    const next = new Set(controls.patterns);
    if (next.has(p)) next.delete(p); else next.add(p);
    onChange({ ...controls, patterns: next });
  };

  // Clear search + filters; leave the persisted sort untouched (R3.4 / §4.6).
  const clearFilters = () =>
    onChange({ ...controls, query: '', difficulties: new Set(), patterns: new Set() });

  const labelClass = 'text-[11px] font-medium text-neutral-500 dark:text-neutral-400';

  return (
    <div className="px-3 py-2 border-b border-neutral-200 dark:border-neutral-700 shrink-0 space-y-2">
      {/* Search (R1) — title-only (R2.1) */}
      <div className="relative">
        <span aria-hidden="true" className="absolute left-2 top-1/2 -translate-y-1/2 text-[11px] text-neutral-400">🔍</span>
        <input
          type="search"
          value={controls.query}
          onChange={(e) => onChange({ ...controls, query: e.target.value })}
          placeholder="Search saved problems…"
          aria-label="Search saved problems"
          className="w-full pl-7 pr-7 py-1.5 text-[11px] rounded-md border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-neutral-700 dark:text-neutral-200 placeholder:text-neutral-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/50"
        />
        {controls.query !== '' && (
          <button
            type="button"
            onClick={() => onChange({ ...controls, query: '' })}
            aria-label="Clear search"
            className="absolute right-2 top-1/2 -translate-y-1/2 text-[11px] text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200"
          >
            ✕
          </button>
        )}
      </div>

      {/* Sort — split pills (label selects, caret flips direction) (R3.1). */}
      <div className="flex items-center gap-1.5 flex-wrap" aria-label="Sort problems">
        <span className={labelClass}>Sort:</span>
        {SORT_OPTIONS.map((opt) => (
          <SortSplitPill
            key={opt.key}
            label={opt.label}
            active={controls.sort.key === opt.key}
            direction={controls.sort.key === opt.key ? controls.sort.direction : 'desc'}
            onSelect={() => onSelectSort(opt.key)}
            onToggleDirection={() => onToggleSortDir(opt.key)}
          />
        ))}
      </div>

      {/* Divider — separates the SORT zone (above) from the FILTER zone (below)
          so "order the list" and "narrow the list" read as distinct (design §R2
          layout revision — the Sort/Difficulty label collision was confusing). */}
      <div className="border-t border-neutral-200/70 dark:border-neutral-700/70" />

      {/* Difficulty filter — toggle pills; E/M/H colored text at rest, full pill
          lights up when selected (R3.2 / R2.3). */}
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className={labelClass}>Difficulty:</span>
        {DIFFICULTIES.map((d) => (
          <FilterPill
            key={d}
            label={d}
            tone={DIFFICULTY_TONE[d]}
            active={controls.difficulties.has(d)}
            onClick={() => toggleDifficulty(d)}
          />
        ))}
      </div>

      {/* Pattern filter — multi-select dropdown (R2.2) + the selected patterns
          shown as removable ✕ pills next to it so the active filter is ALWAYS
          visible (not hidden behind "N selected"). Omitted if the user has no
          patterns. Reuses the Download-menu dropdown pattern. */}
      {patternFacets.length > 0 && (
        <div className="flex items-start gap-1.5 flex-wrap">
          <span className={`${labelClass} mt-0.5`}>Pattern:</span>
          <div className="relative" ref={patternMenuRef}>
            <button
              type="button"
              onClick={() => setPatternOpen(v => !v)}
              aria-haspopup="menu"
              aria-expanded={patternOpen}
              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium border transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/50
                ${controls.patterns.size > 0
                  ? 'border-blue-500/50 bg-blue-500/15 text-blue-600 dark:text-blue-300'
                  : 'border-neutral-200 dark:border-neutral-700 text-neutral-500 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800'}`}
            >
              <span>{controls.patterns.size > 0 ? `${controls.patterns.size} selected` : 'Choose patterns'}</span>
              <span aria-hidden="true" className="text-[9px] opacity-70">▾</span>
            </button>
            {patternOpen && (
              <div
                role="menu"
                className="absolute left-0 mt-1 z-10 max-h-56 overflow-y-auto min-w-[11rem] rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 shadow-lg py-1 text-[11px]"
              >
                {patternFacets.map((p) => {
                  const checked = controls.patterns.has(p);
                  return (
                    <button
                      key={p}
                      role="menuitemcheckbox"
                      aria-checked={checked}
                      onClick={() => togglePattern(p)}
                      className="w-full text-left px-2.5 py-1.5 flex items-center gap-2 hover:bg-neutral-100 dark:hover:bg-neutral-700"
                    >
                      <span
                        aria-hidden="true"
                        className={`w-3.5 h-3.5 shrink-0 rounded border flex items-center justify-center text-[9px]
                          ${checked ? 'bg-blue-500 border-blue-500 text-white' : 'border-neutral-300 dark:border-neutral-600'}`}
                      >
                        {checked ? '✓' : ''}
                      </span>
                      <span className="break-words">{p}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Selected-pattern pills — each removable with its ✕ (R3.4). They
              wrap to new lines as needed in the narrow panel. Rendered in the
              canonical facet order so their position is stable as you toggle. */}
          {patternFacets
            .filter((p) => controls.patterns.has(p))
            .map((p) => (
              <span
                key={p}
                className="inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-full text-[11px] font-medium border border-blue-500/50 bg-blue-500/15 text-blue-600 dark:text-blue-300"
              >
                <span className="break-words">{p}</span>
                <button
                  type="button"
                  onClick={() => togglePattern(p)}
                  aria-label={`Remove ${p} filter`}
                  title={`Remove ${p} filter`}
                  className="shrink-0 w-4 h-4 flex items-center justify-center rounded-full text-[10px] opacity-70 hover:opacity-100 hover:bg-blue-500/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/50"
                >
                  ✕
                </button>
              </span>
            ))}
        </div>
      )}

      {/* Clear — only when a transient filter/search is active (R3.4) */}
      {hasActiveFilters && (
        <button
          type="button"
          onClick={clearFilters}
          className="text-[11px] text-blue-500 hover:underline"
        >
          Clear all
        </button>
      )}
    </div>
  );
};

/**
 * A compact icon-only button for the header data-action cluster (design §R2.6).
 * The label lives in the `title` tooltip + `aria-label` (icon-only to reclaim
 * vertical space). `active` gives a success tint (e.g. after "Copy all").
 */
const HeaderIconButton: React.FC<{
  onClick: () => void;
  title: string;
  children: React.ReactNode;
  active?: boolean;
  ariaHasPopup?: boolean;
  ariaExpanded?: boolean;
}> = ({ onClick, title, children, active, ariaHasPopup, ariaExpanded }) => (
  <button
    onClick={onClick}
    title={title}
    aria-label={title}
    aria-haspopup={ariaHasPopup ? 'menu' : undefined}
    aria-expanded={ariaHasPopup ? ariaExpanded : undefined}
    className={`w-7 h-7 flex items-center justify-center rounded-md transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/50
      ${active
        ? 'text-green-600 dark:text-green-400 bg-green-500/10'
        : 'text-neutral-500 dark:text-neutral-300 hover:text-neutral-700 dark:hover:text-neutral-100 hover:bg-neutral-200/60 dark:hover:bg-neutral-700/60'}`}
  >
    {children}
  </button>
);

/** Minimum saved problems before insights are meaningful enough to show. */
const INSIGHTS_MIN_PROBLEMS = 3;

/** Strips the outer O(...) wrapper for compact "O(n²) vs O(n)" rendering. */
function fmtBigO(c: string): string {
  return (c || '').trim();
}

/** Human phrasing for the revisit reasons (gave-up dropped — overhaul). */
const REVISIT_REASON_LABEL: Record<'may-be-suboptimal' | 'high-hints' | 'stale', string> = {
  'may-be-suboptimal': 'may be suboptimal',
  'high-hints': 'high hints',
  'stale': 'stale',
};

/**
 * A small ⓘ info affordance with a REAL click-to-toggle popover. The honesty
 * caveats (R7 — "the model owns judgments, the system owns facts") used to be
 * persistent fine print, which cluttered the panel. They live here now — one
 * click away — so the honesty is preserved but never shouts.
 *
 * Why a popover, not a native `title`: the browser `title` tooltip is
 * unreliable (hover-only, slow, and suppressed on some setups — it showed
 * nothing on a real review). This toggles an inline panel on click AND keyboard
 * (Enter/Space), closes on outside-click / Escape, and exposes the text to
 * assistive tech via aria. It renders the caveat INLINE (not an OS tooltip) so
 * it's always visible when open.
 */
const InfoHint: React.FC<{ text: string; label?: string }> = ({ text, label = 'More info' }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onClick); document.removeEventListener('keydown', onKey); };
  }, [open]);
  return (
    <span ref={ref} className="relative inline-flex align-middle">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        aria-expanded={open}
        aria-label={label}
        title={label}
        className="ml-1 inline-flex items-center justify-center w-4 h-4 rounded-full text-[10px] font-semibold leading-none text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200 border border-neutral-300 dark:border-neutral-600 cursor-help focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/50"
      >
        i
      </button>
      {open && (
        <span
          role="tooltip"
          className="absolute left-0 top-5 z-20 w-56 p-2 rounded-md bg-neutral-800 dark:bg-neutral-900 text-neutral-100 text-[10.5px] leading-snug shadow-lg border border-neutral-700"
        >
          {text}
        </span>
      )}
    </span>
  );
};

/** Shared card-title styling — bigger + higher-contrast than before (readable). */
const CARD_TITLE = 'text-[13px] font-semibold text-neutral-800 dark:text-neutral-100';

/**
 * R1 — the "Am I improving?" trend card. A plain-language HEADLINE (the answer)
 * + a one-line "because…" subline that explains what we mean in human terms, so
 * the verdict is immediately interpretable (a bare arrow / "Holding steady" was
 * not). No sparkline: a per-problem "struggle" bar chart has no honest axis (the
 * y-value is an invented unitless composite), so it was decoration, not
 * information — removed deliberately (design §2.2 / R1.3). The formal honesty
 * caveat lives on the ⓘ popover. Degrades to "Not enough data yet" below the
 * threshold (R1.2).
 */
const TrendCard: React.FC<{ trend: ProgressInsights['trend'] }> = ({ trend }) => {
  const map = {
    improving: {
      icon: '📈', label: "You're improving", color: 'text-green-500',
      why: "You're reaching for fewer hints and hitting better complexity than when you started.",
    },
    'needs-work': {
      icon: '🎯', label: 'Pushing into harder territory', color: 'text-orange-500',
      why: 'Your recent problems are leaning on more hints and effort — a sign you\'re taking on tougher challenges.',
    },
    flat: {
      icon: '➖', label: 'About the same', color: 'text-blue-500',
      why: 'Your recent problems look about as challenging as your earlier ones.',
    },
    insufficient: {
      icon: '🌱', label: 'Not enough data yet', color: 'text-neutral-400',
      why: "Save a few more problems and I'll start tracking whether you're improving.",
    },
  } as const;
  const v = map[trend.direction];
  return (
    <div className="p-3 rounded-lg bg-neutral-100 dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700">
      <div className="flex items-center">
        <span className={CARD_TITLE}>Am I improving?</span>
        <InfoHint
          label="What this is based on"
          text="A practice signal drawn from how many hints you used and the complexity your solutions reached across your saved problems."
        />
      </div>
      <div className="mt-1.5">
        <span className={`text-[19px] font-bold ${v.color}`}>{v.icon} {v.label}</span>
      </div>
      <div className="text-[12px] text-neutral-600 dark:text-neutral-300 mt-1 leading-snug">{v.why}</div>
      {trend.direction !== 'insufficient' && (
        <div className="text-[11px] text-neutral-400 mt-1">Compared across your {trend.sampleSize} saved problems.</div>
      )}
    </div>
  );
};

/**
 * R3 — "Room to optimize": a FLAG of candidates to review, NEVER a verdict
 * (R3.1). Positively framed for the user ("room to optimize", "sharpen"); the ⓘ
 * explains what it's based on. Hidden entirely when there are no flags (so an
 * empty block never implies anything). The honesty requirement (R3.4/R3.5) is
 * still met in the DESIGN + the data (the flag only fires on an unambiguous
 * ≥1-class gap), but the surface copy stays encouraging rather than listing
 * caveats about what the tool can't do (user's call — positive, objective copy).
 */
const ReviewCandidates: React.FC<{ flags: ProgressInsights['efficiencyFlags'] }> = ({ flags }) => {
  if (flags.length === 0) return null;
  return (
    <div className="p-3 rounded-lg bg-amber-500/5 border border-amber-500/30">
      <div className="flex items-center">
        <span className={CARD_TITLE}>Room to optimize</span>
        <InfoHint
          label="How these are flagged"
          text="Solutions where the complexity you reached is a step above the optimal for that problem — handy candidates to revisit and sharpen."
        />
      </div>
      <ul className="mt-1.5 space-y-1">
        {flags.slice(0, 6).map(f => (
          <li key={f.slug} className="text-[12px] text-neutral-700 dark:text-neutral-200 break-words">
            • {f.title} <span className="text-neutral-500 dark:text-neutral-400">— {fmtBigO(f.achieved.time)} vs {fmtBigO(f.optimal.time)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
};

/** R5 — the compact at-a-glance dashboard strip (sits BELOW the core insights). */
const DashboardStrip: React.FC<{ dashboard: ProgressInsights['dashboard']; totalProblems: number }> = ({ dashboard, totalProblems }) => {
  const d = dashboard;
  const lastActive = d.lastActiveAt > 0 ? timeAgo(d.lastActiveAt) : '—';
  return (
    <div className="p-3 rounded-lg bg-neutral-100 dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700">
      <div className={`${CARD_TITLE} mb-1.5`}>At a glance</div>
      <div className="text-[12px] text-neutral-600 dark:text-neutral-300 space-y-1">
        <div>
          <span className="text-green-600 dark:text-green-400 font-medium">Easy {d.byDifficulty.Easy}</span>{' · '}
          <span className="text-yellow-600 dark:text-yellow-400 font-medium">Medium {d.byDifficulty.Medium}</span>{' · '}
          <span className="text-red-500 font-medium">Hard {d.byDifficulty.Hard}</span>
        </div>
        <div className="text-neutral-500 dark:text-neutral-400">{totalProblems} problems · {d.patternCoverage} patterns · active {d.activeDays} day{d.activeDays === 1 ? '' : 's'} · last {lastActive}</div>
        {d.reviewedCandidates > 0 && (
          <div className="text-neutral-500 dark:text-neutral-400">{d.reviewedCandidates} worth a second look (see above)</div>
        )}
      </div>
    </div>
  );
};

/**
 * The insights panel — reads from computeInsights. Hidden until there are enough
 * problems to say anything trustworthy; once shown, four blocks answer the three
 * user questions + a dashboard (design §1): trend (R1), weakest + strongest
 * (R2), review candidates (R3), and the at-a-glance strip (R5). Honesty caveats
 * live on ⓘ popovers (decluttered after visual-review passes); the standalone
 * confidence badge was removed as unclear — the low-confidence gate still
 * governs WHETHER weakest/strongest are surfaced (design §3.2 / R2.3).
 */
const InsightsPanel: React.FC<{ insights: ProgressInsights }> = ({ insights }) => {
  if (insights.totalProblems < INSIGHTS_MIN_PROBLEMS) return null;
  const w = insights.weakestLink;
  const s = insights.strongestLink;
  return (
    <div className="mb-3 space-y-2.5">
      <div className="flex items-center">
        <div className="text-[15px] font-bold text-neutral-800 dark:text-neutral-100">📊 Insights</div>
      </div>

      {/* R1 — trend */}
      <TrendCard trend={insights.trend} />

      {/* R2 — weakest + strongest */}
      <div className="p-3 rounded-lg bg-neutral-100 dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700">
        <div className="flex items-center mb-1.5">
          <span className={CARD_TITLE}>What to work on next</span>
          <InfoHint
            label="How this ranking works"
            text="Ranked from your hints, problem difficulty, how close your solutions got to optimal, and how deep you went with the coaching tools."
          />
        </div>
        <div className="text-[12.5px] space-y-1.5">
          {w && (
            <div>
              <span className="text-neutral-500 dark:text-neutral-400">Weakest:</span>{' '}
              <span className="text-orange-500 font-semibold">{w.pattern}</span>{' '}
              <span className="text-neutral-400">({w.problemCount} problem{w.problemCount === 1 ? '' : 's'})</span>
            </div>
          )}
          {s && (
            <div>
              <span className="text-neutral-500 dark:text-neutral-400">Strongest:</span>{' '}
              <span className="text-green-500 font-semibold">{s.pattern}</span>{' '}
              <span className="text-neutral-400">({s.problemCount} problem{s.problemCount === 1 ? '' : 's'})</span>
            </div>
          )}
          {insights.revisit.length > 0 && (
            <div className="pt-0.5 text-neutral-600 dark:text-neutral-300">
              <span className="text-neutral-500 dark:text-neutral-400">Worth revisiting:</span>{' '}
              {insights.revisit.slice(0, 5).map((r, i) => (
                <span key={r.slug}>
                  {i > 0 ? ', ' : ''}{r.title} <span className="text-neutral-400">({REVISIT_REASON_LABEL[r.reason]})</span>
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* R3 — review candidates (hidden when none) */}
      <ReviewCandidates flags={insights.efficiencyFlags} />

      {/* R5 — compact dashboard strip (bottom, never buries R1–R3) */}
      <DashboardStrip dashboard={insights.dashboard} totalProblems={insights.totalProblems} />
    </div>
  );
};

/** The detail view for a single record: notes + attempts timeline. */
const RecordDetail: React.FC<{ record: ProblemRecord; onBack: () => void; onDelete: () => void }> = ({ record, onBack, onDelete }) => {
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    try { await navigator.clipboard.writeText(record.notes); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* ignore */ }
  };
  return (
    <div>
      <button onClick={onBack} className="text-[11px] text-blue-500 hover:underline mb-2">← Back to list</button>
      <div className="flex items-start justify-between gap-2 mb-1">
        <div className="font-semibold text-sm break-words">{record.title}</div>
        <div className="flex items-center gap-2 shrink-0">
          <LeetCodeLink url={record.url} title={record.title} iconSize={15} />
          <span className={`text-[11px] font-bold ${difficultyColor[record.difficulty] ?? ''}`}>{record.difficulty}</span>
        </div>
      </div>
      <PatternChips patterns={record.patterns} />
      <div className="text-[10px] text-neutral-400 mt-1">
        Updated {timeAgo(record.lastUpdatedAt)}
      </div>

      <div className="mt-3 text-[12px] font-semibold">History</div>
      <ol className="mt-1 space-y-1.5">
        {record.attempts.map((a, i) => (
          <li key={i} className={`text-[11px] p-2 rounded border ${i === record.bestAttemptIndex ? 'border-green-500/50 bg-green-500/5' : 'border-neutral-200 dark:border-neutral-700'}`}>
            <div className="flex items-center justify-between">
              <span className="font-medium capitalize">{a.outcome}{i === record.bestAttemptIndex ? ' · best' : ''}</span>
              <span className="text-neutral-400">{new Date(a.date).toLocaleDateString()}</span>
            </div>
            <div className="text-neutral-500 dark:text-neutral-400 break-words">{a.approachSummary}</div>
            <div className="text-neutral-400">
              {a.complexity.time} time / {a.complexity.space} space · {a.hintsUsed} hint{a.hintsUsed === 1 ? '' : 's'}{displayLanguage(a.language) ? ` · ${displayLanguage(a.language)}` : ''}
            </div>
          </li>
        ))}
      </ol>

      <div className="mt-3 flex items-center justify-between">
        <div className="text-[12px] font-semibold">Note</div>
        <div className="flex gap-2">
          <button onClick={handleCopy} className="text-[11px] text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200">{copied ? '✓ Copied' : '⧉ Copy'}</button>
          <button onClick={onDelete} className="text-[11px] text-red-500 hover:underline">Delete</button>
        </div>
      </div>
      <pre className="mt-1 text-[11px] whitespace-pre-wrap break-words bg-neutral-100 dark:bg-neutral-800 rounded p-2 max-h-48 overflow-y-auto">{record.notes || '(no note saved)'}</pre>
    </div>
  );
};

/**
 * Triggers a client-side file download (R4.1). The side panel is a full DOM
 * document (not the DOM-less service worker), so the Blob + object-URL +
 * temporary <a download> click works here exactly like on a web page — no
 * `chrome.downloads` API and no "downloads" permission needed. (Verified: the
 * createObjectURL/anchor limitation is specific to the background worker, which
 * lacks a document; keeping the permission set minimal matters for the upcoming
 * scope-permissions work.)
 */
function downloadFile(filename: string, contents: string, mime: string): void {
  const blob = new Blob([contents], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next tick so the click has consumed the URL.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Date-stamped export filename, e.g. leetsmith-progress-2026-09-27.json (R1.4/R2.3).
 *  NB: only the download FILENAME carries the new brand; the in-file envelope
 *  discriminator stays `EXPORT_FORMAT_ID = 'leetsage-progress'` (a data-schema
 *  contract) so old backups still import — import keys off file CONTENT, not name. */
function exportFilename(ext: 'md' | 'json'): string {
  return `leetsmith-progress-${new Date().toISOString().slice(0, 10)}.${ext}`;
}

const ProgressView: React.FC<ProgressViewProps> = ({ onClose }) => {
  const [index, setIndex] = useState<ProblemIndexEntry[]>([]);
  const [records, setRecords] = useState<ProblemRecord[]>([]);
  const [selected, setSelected] = useState<ProblemRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [copiedAll, setCopiedAll] = useState(false);
  const [downloadOpen, setDownloadOpen] = useState(false);
  const [importMsg, setImportMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  // Search/filter/sort controls. query/difficulties/patterns are transient (R1.6);
  // only `sort` is seeded from and written back to storage (design §4.6).
  const [controls, setControls] = useState<ListControls>(DEFAULT_CONTROLS);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const downloadMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    (async () => {
      const idx = await getProgressIndex();
      idx.sort((a, b) => b.lastUpdatedAt - a.lastUpdatedAt);
      setIndex(idx);
      // Load full records for analytics (small; ~1-2KB each). The list itself
      // only needs the index, but insights aggregate over records.
      const recs = (await Promise.all(idx.map(e => getRecord(e.slug)))).filter((r): r is ProblemRecord => !!r);
      setRecords(recs);
      // Seed ONLY the sort from storage (persisted preference, §4.6); search and
      // filters stay at their transient defaults (R1.6).
      const sort = await getProgressListSort();
      setControls(c => ({ ...c, sort }));
      setLoading(false);
    })();
  }, []);

  // Persist the sort (field + direction) whenever it changes. Keyed on the
  // primitive key+direction (not the object identity) so it writes once per real
  // change and never on search/filter edits (§4.6). Depending on the two
  // primitives is the correct, churn-free dependency set here.
  useEffect(() => {
    void saveProgressListSort(controls.sort);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controls.sort.key, controls.sort.direction]);

  const insights = useMemo(() => computeInsights(records), [records]);
  const patternFacets = useMemo(() => collectPatternFacets(index), [index]);
  // The visible list = index after search + filters, in the chosen sort order.
  // `index` stays immutable so clearing a filter restores the full list (R3.7).
  const visible = useMemo(() => filterSortProblems(index, controls), [index, controls]);

  const openRecord = async (slug: string) => {
    const r = await getRecord(slug);
    if (r) setSelected(r);
  };

  const handleDelete = async (slug: string) => {
    await deleteRecord(slug);
    setIndex(prev => prev.filter(e => e.slug !== slug));
    setRecords(prev => prev.filter(r => r.slug !== slug));
    setSelected(null);
  };

  const handleCopyAll = async () => {
    try {
      await navigator.clipboard.writeText(buildProgressReportMarkdown(records));
      setCopiedAll(true);
      setTimeout(() => setCopiedAll(false), 1500);
    } catch { /* clipboard can fail if unfocused; ignore */ }
  };

  // Close the download menu on an outside click.
  useEffect(() => {
    if (!downloadOpen) return;
    const onClick = (e: MouseEvent) => {
      if (downloadMenuRef.current && !downloadMenuRef.current.contains(e.target as Node)) {
        setDownloadOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setDownloadOpen(false); };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [downloadOpen]);

  const handleDownloadMarkdown = () => {
    downloadFile(exportFilename('md'), buildProgressReportMarkdown(records), 'text/markdown');
    setDownloadOpen(false);
  };

  const handleDownloadJson = () => {
    downloadFile(exportFilename('json'), serializeProgressExport(records), 'application/json');
    setDownloadOpen(false);
  };

  /** Reads the picked file, runs the pure import pipeline, then writes atomically. */
  const handleImportFile = async (file: File) => {
    setImportMsg(null);
    let text: string;
    try {
      text = await file.text();
    } catch {
      setImportMsg({ kind: 'error', text: 'Could not read that file.' });
      return;
    }

    const result = parseImport(text);
    if (result.error) {
      // Hard fail — storage untouched (R5.5.1).
      setImportMsg({ kind: 'error', text: result.error });
      return;
    }

    // Merge against the current full record set (newer-wins), then write once.
    const existing = await getAllRecords();
    const { merged, summary } = mergeRecords(existing, result.records);
    const write = await writeImportedRecords(merged, existing.map(r => r.slug));
    if (!write.ok) {
      setImportMsg({ kind: 'error', text: write.error ?? 'Import failed; nothing was changed.' });
      return;
    }

    // Refresh the view from storage (R3.4).
    const idx = await getProgressIndex();
    idx.sort((a, b) => b.lastUpdatedAt - a.lastUpdatedAt);
    setIndex(idx);
    setRecords(await getAllRecords());
    setSelected(null);

    const skippedNote = result.skipped > 0 ? ` (${result.skipped} record${result.skipped === 1 ? '' : 's'} in the file were invalid and ignored)` : '';
    setImportMsg({
      kind: 'ok',
      text: `Imported: ${summary.added} added, ${summary.updated} updated, ${summary.skipped} unchanged${skippedNote}.`,
    });
  };

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Reset so picking the same file again re-fires the change event.
    e.target.value = '';
    if (file) void handleImportFile(file);
  };

  // Full-panel screen (not a modal): fills the whole side panel below the app
  // header, so it reads as a place you navigated to rather than a dialog
  // floating over faintly-visible content — which looked off in a narrow panel.
  return (
    <div className="flex-1 min-w-0 flex flex-col bg-neutral-50 dark:bg-neutral-900 overflow-hidden">
      {/* Header — identity + the data-action icon cluster + close (design §R2.6).
          The data actions (Copy all / Download ▾ / Import) are icon-only here to
          reclaim vertical space; labels live in tooltips. Cluster sits left of a
          gapped ✕. Shown on the list screen (hidden in the detail view). The file
          input is always mounted (hidden). */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-neutral-200 dark:border-neutral-700 shrink-0 gap-2">
        <div className="flex items-baseline gap-1.5 min-w-0">
          <span className="text-sm">📈</span>
          <span className="text-sm font-semibold truncate">My Progress</span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {!loading && !selected && (
            <>
              {index.length > 0 && (
                <>
                  <HeaderIconButton
                    onClick={handleCopyAll}
                    title={copiedAll ? 'Copied all notes' : 'Copy all saved notes to the clipboard as one Markdown document'}
                    active={copiedAll}
                  >
                    {copiedAll ? <span aria-hidden="true" className="text-[13px]">✓</span> : <CopyIcon />}
                  </HeaderIconButton>

                  {/* Download ▾ menu — Markdown (study archive) / JSON (backup) */}
                  <div className="relative" ref={downloadMenuRef}>
                    <HeaderIconButton
                      onClick={() => setDownloadOpen(v => !v)}
                      title="Download your progress as a file"
                      ariaHasPopup
                      ariaExpanded={downloadOpen}
                    >
                      <DownloadIcon />
                    </HeaderIconButton>
                    {downloadOpen && (
                      <div
                        role="menu"
                        className="absolute right-0 mt-1 z-20 min-w-[13rem] rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 shadow-lg py-1 text-[12px]"
                      >
                        <button role="menuitem" onClick={handleDownloadMarkdown} className="w-full text-left px-3 py-2 hover:bg-neutral-100 dark:hover:bg-neutral-700 flex flex-col">
                          <span className="font-medium">📄 Markdown</span>
                          <span className="text-[10px] text-neutral-400">Readable study report (.md)</span>
                        </button>
                        <button role="menuitem" onClick={handleDownloadJson} className="w-full text-left px-3 py-2 hover:bg-neutral-100 dark:hover:bg-neutral-700 flex flex-col">
                          <span className="font-medium">🗄 JSON</span>
                          <span className="text-[10px] text-neutral-400">Backup to restore / move (.json)</span>
                        </button>
                      </div>
                    )}
                  </div>
                </>
              )}
              <HeaderIconButton
                onClick={() => fileInputRef.current?.click()}
                title="Import a previously-exported LeetSmith JSON backup"
              >
                <ImportIcon />
              </HeaderIconButton>
              {/* gap before close so the data cluster isn't mistaken for ✕ */}
              <span className="w-px h-5 bg-neutral-200 dark:bg-neutral-700 mx-0.5" aria-hidden="true" />
            </>
          )}
          <button
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded-md text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 hover:bg-neutral-200/60 dark:hover:bg-neutral-700/60 transition-colors"
            aria-label="Close My Progress"
            title="Back to coaching"
          >
            ✕
          </button>
        </div>
      </div>
      <input
        ref={fileInputRef}
        type="file"
        accept=".json,application/json"
        onChange={onFileChange}
        className="hidden"
        aria-hidden="true"
      />

      {/* Search + filter + sort controls (R1/R3) — FIXED band (design §R2.8).
          List screen only, and only once there is something to navigate. */}
      {!loading && !selected && index.length > 0 && (
        <ListControlsBar controls={controls} patternFacets={patternFacets} onChange={setControls} />
      )}

      <div className="flex-1 p-3 overflow-y-auto">
        {/* Import feedback (R6.2) — success counts or a specific rejection reason.
            Inside the scroll area, at the top (transient status). */}
        {importMsg && !selected && (
          <div
            className={`mb-3 px-3 py-1.5 text-[11px] rounded-md border flex items-center justify-between gap-2 ${
              importMsg.kind === 'ok'
                ? 'bg-green-500/10 text-green-700 dark:text-green-300 border-green-500/20'
                : 'bg-red-500/10 text-red-700 dark:text-red-300 border-red-500/20'
            }`}
            role="status"
          >
            <span className="break-words">{importMsg.kind === 'ok' ? '✓ ' : '⚠ '}{importMsg.text}</span>
            <button onClick={() => setImportMsg(null)} className="shrink-0 opacity-60 hover:opacity-100" aria-label="Dismiss">✕</button>
          </div>
        )}
        {loading ? (
          <div className="text-center text-neutral-400 text-xs py-6">Loading…</div>
        ) : selected ? (
          <RecordDetail record={selected} onBack={() => setSelected(null)} onDelete={() => handleDelete(selected.slug)} />
        ) : index.length === 0 ? (
          <div className="text-center text-neutral-400 text-xs py-10 px-4">
            <div className="text-3xl mb-2">📈</div>
            <p>No saved progress yet.</p>
            <p className="mt-1">Generate a study report on a problem, then click <span className="font-medium">💾 Save to My Progress</span> to start building your record.</p>
          </div>
        ) : visible.length === 0 ? (
          /* R1.4 — a distinct "no matches" state (vs. the genuinely-empty
             dataset state above), with a way to clear the filters. */
          <div className="text-center text-neutral-400 text-xs py-10 px-4">
            <div className="text-3xl mb-2">🔍</div>
            <p>No problems match your filters.</p>
            <button
              type="button"
              onClick={() => setControls(c => ({ ...c, query: '', difficulties: new Set(), patterns: new Set() }))}
              className="mt-2 text-[11px] text-blue-500 hover:underline"
            >
              Clear all
            </button>
          </div>
        ) : (
          <>
            {/* Insights scrolls at the top of the list area (design §R2.8). */}
            <InsightsPanel insights={insights} />
            <div className="space-y-1.5">
              {visible.map(e => (
                /* The whole row opens the in-panel detail; the inline ↗ opens
                   LeetCode. The row is a `div role="button"` (not a <button>) so
                   a REAL inline <a> can live next to the title without nesting
                   interactive elements (design §R2.5, option B). Enter/Space on
                   the row opens detail; the ↗ stops propagation so it never does. */
                <div
                  key={e.slug}
                  role="button"
                  tabIndex={0}
                  onClick={() => openRecord(e.slug)}
                  onKeyDown={(ev) => {
                    if (ev.key === 'Enter' || ev.key === ' ') {
                      ev.preventDefault();
                      openRecord(e.slug);
                    }
                  }}
                  className="w-full text-left p-2.5 rounded-lg border border-neutral-200 dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800 hover:border-blue-400 dark:hover:border-blue-500 transition-colors group cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/50"
                >
                  <div className="flex items-start justify-between gap-2">
                    {/* Title + ↗ as INLINE flow (not flexbox) so the icon sits
                        right after the last word even when the title wraps,
                        instead of floating to the far right of a multi-line
                        block. `align-middle` keeps it level with the text. */}
                    <span className="min-w-0 text-[13px] font-medium break-words">
                      {e.title}
                      <LeetCodeLink url={e.url} title={e.title} iconSize={13} className="ml-1 align-middle" />
                    </span>
                    <span className={`text-[10px] font-bold shrink-0 mt-0.5 ${difficultyColor[e.difficulty] ?? ''}`}>{e.difficulty}</span>
                  </div>
                  <div className="mt-1"><PatternChips patterns={e.patterns} /></div>
                  <div className="flex items-center justify-between mt-1">
                    <span className="text-[10px] text-neutral-400">
                      Updated {timeAgo(e.lastUpdatedAt)}
                    </span>
                    <span className="text-[11px] text-neutral-300 dark:text-neutral-600 group-hover:text-blue-400 transition-colors">View →</span>
                  </div>
                </div>
              ))}
            </div>

            {/* Local-first note (E8 / R13.1) — moved to the BOTTOM of the scroll
                area (design §R2.8) so it reads as a footnote to the whole list
                instead of occupying a permanent band. Accurate + non-alarmist:
                data persists in chrome.storage.local and is NOT lost on normal
                close/restart — only on uninstall, clearing browser data, or
                switching devices. */}
            <p className="mt-4 pt-3 border-t border-neutral-200 dark:border-neutral-700 text-[10px] text-neutral-400">
              Your progress is stored locally in this browser. Export a backup to keep it if you reinstall or switch devices.
            </p>
          </>
        )}
      </div>
    </div>
  );
};

export default ProgressView;
