import { describe, it, expect } from 'vitest';
import {
  filterSortProblems,
  collectPatternFacets,
  leetcodeHref,
  isSortKey,
  normalizeSort,
  selectOrResetSort,
  toggleSortDirection,
  DEFAULT_CONTROLS,
  DEFAULT_SORT,
  type ListControls,
  type Sort,
  type SortKey,
} from '../progress-list-controls';
import type { ProblemIndexEntry, ProblemPattern } from '../../types';

/**
 * Pure list-control logic for the progress screen
 * (see .kiro/specs/leetsage-progress-quick-wins §R4.3). These pin the
 * search/filter/sort predicate + comparator and the LeetCode-link guard, all
 * DOM-free under the repo's node vitest env.
 */

/** A small fixture: already recency-sorted (newest first), like the loaded index. */
function entry(
  title: string,
  difficulty: ProblemIndexEntry['difficulty'],
  patterns: ProblemPattern[],
  lastUpdatedAt: number,
  url = `https://leetcode.com/problems/${title.toLowerCase().replace(/\s+/g, '-')}/`,
): ProblemIndexEntry {
  return {
    slug: title.toLowerCase().replace(/\s+/g, '-'),
    url,
    title,
    difficulty,
    patterns,
    attemptCount: 1,
    lastUpdatedAt,
  };
}

const sample: ProblemIndexEntry[] = [
  entry('Two Sum', 'Easy', ['Hash Map', 'Two Pointers'], 500),
  entry('Valid Parentheses', 'Easy', ['Stack'], 400),
  entry('Course Schedule', 'Medium', ['DFS', 'Graph'], 300),
  entry('Word Ladder', 'Hard', ['BFS', 'Graph'], 200),
  entry('Median of Two Sorted Arrays', 'Hard', ['Binary Search'], 100),
];

function controls(overrides: Partial<ListControls>): ListControls {
  return {
    query: '',
    difficulties: new Set(),
    patterns: new Set(),
    sort: { ...DEFAULT_SORT },
    ...overrides,
  };
}

/** Shorthand for a sort spec in tests. */
const s = (key: SortKey, direction: 'asc' | 'desc'): Sort => ({ key, direction });

describe('filterSortProblems — default identity (R3.7)', () => {
  it('returns the input in the same order with DEFAULT_CONTROLS', () => {
    const out = filterSortProblems(sample, DEFAULT_CONTROLS);
    expect(out).toEqual(sample);
    expect(out.map((e) => e.title)).toEqual([
      'Two Sum', 'Valid Parentheses', 'Course Schedule', 'Word Ladder',
      'Median of Two Sorted Arrays',
    ]);
  });
});

describe('filterSortProblems — search (R1.2/R1.4)', () => {
  it('empty / whitespace query returns all entries', () => {
    expect(filterSortProblems(sample, controls({ query: '' }))).toHaveLength(5);
    expect(filterSortProblems(sample, controls({ query: '   ' }))).toHaveLength(5);
  });

  it('matches title case-insensitively, substring', () => {
    expect(filterSortProblems(sample, controls({ query: 'two' })).map((e) => e.title))
      .toEqual(['Two Sum', 'Median of Two Sorted Arrays']);
    expect(filterSortProblems(sample, controls({ query: 'SUM' })).map((e) => e.title))
      .toEqual(['Two Sum']);
  });

  it('returns [] when nothing matches (drives the no-matches empty state)', () => {
    expect(filterSortProblems(sample, controls({ query: 'zzz-nonexistent' }))).toEqual([]);
  });
});

describe('filterSortProblems — difficulty filter (R3.2, OR within category)', () => {
  it('single difficulty', () => {
    expect(filterSortProblems(sample, controls({ difficulties: new Set(['Easy']) })).map((e) => e.title))
      .toEqual(['Two Sum', 'Valid Parentheses']);
  });

  it('two difficulties are OR-ed within the category', () => {
    const out = filterSortProblems(sample, controls({ difficulties: new Set(['Easy', 'Hard']) }));
    expect(out.map((e) => e.title)).toEqual([
      'Two Sum', 'Valid Parentheses', 'Word Ladder', 'Median of Two Sorted Arrays',
    ]);
  });
});

describe('filterSortProblems — pattern filter (R3.2, OR within category)', () => {
  it('single pattern returns entries having it', () => {
    expect(filterSortProblems(sample, controls({ patterns: new Set(['Graph']) })).map((e) => e.title))
      .toEqual(['Course Schedule', 'Word Ladder']);
  });

  it('an entry with multiple patterns matches if ANY selected pattern is present', () => {
    // Two Sum has [Hash Map, Two Pointers]; selecting just Two Pointers matches it.
    expect(filterSortProblems(sample, controls({ patterns: new Set(['Two Pointers']) })).map((e) => e.title))
      .toEqual(['Two Sum']);
  });
});

describe('filterSortProblems — composition (R1.5/R3.5, AND across categories)', () => {
  it('search + difficulty + pattern + non-recent sort compose predictably', () => {
    // Hard AND Graph → Word Ladder only (Course Schedule is Medium); sort title.
    const out = filterSortProblems(
      sample,
      controls({ difficulties: new Set(['Hard']), patterns: new Set(['Graph']), sort: s('title', 'asc') }),
    );
    expect(out.map((e) => e.title)).toEqual(['Word Ladder']);
  });

  it('AND across categories narrows to the intersection', () => {
    // Easy AND Stack → Valid Parentheses only (Two Sum is Easy but not Stack).
    const out = filterSortProblems(
      sample,
      controls({ difficulties: new Set(['Easy']), patterns: new Set(['Stack']) }),
    );
    expect(out.map((e) => e.title)).toEqual(['Valid Parentheses']);
  });
});

describe('filterSortProblems — sort field + direction (R3.1, bidirectional)', () => {
  it('recent desc is the pass-through (default, == load order, R3.7)', () => {
    expect(filterSortProblems(sample, controls({ sort: s('recent', 'desc') }))).toEqual(sample);
  });

  it('recent asc reverses to oldest-first', () => {
    expect(filterSortProblems(sample, controls({ sort: s('recent', 'asc') })).map((e) => e.title))
      .toEqual([
        'Median of Two Sorted Arrays', 'Word Ladder', 'Course Schedule',
        'Valid Parentheses', 'Two Sum',
      ]);
  });

  it('difficulty asc: Easy→Hard with title tiebreak', () => {
    expect(filterSortProblems(sample, controls({ sort: s('difficulty', 'asc') })).map((e) => e.title))
      .toEqual([
        'Two Sum',            // Easy (T < V)
        'Valid Parentheses',  // Easy
        'Course Schedule',    // Medium
        'Median of Two Sorted Arrays', // Hard (M < W)
        'Word Ladder',        // Hard
      ]);
  });

  it('difficulty desc: Hard→Easy, fully reversed (tiebreak flips too)', () => {
    expect(filterSortProblems(sample, controls({ sort: s('difficulty', 'desc') })).map((e) => e.title))
      .toEqual([
        'Word Ladder',        // Hard (W > M)
        'Median of Two Sorted Arrays', // Hard
        'Course Schedule',    // Medium
        'Valid Parentheses',  // Easy (V > T)
        'Two Sum',            // Easy
      ]);
  });

  it('title asc: A–Z', () => {
    expect(filterSortProblems(sample, controls({ sort: s('title', 'asc') })).map((e) => e.title))
      .toEqual([
        'Course Schedule', 'Median of Two Sorted Arrays', 'Two Sum',
        'Valid Parentheses', 'Word Ladder',
      ]);
  });

  it('title desc: Z–A', () => {
    expect(filterSortProblems(sample, controls({ sort: s('title', 'desc') })).map((e) => e.title))
      .toEqual([
        'Word Ladder', 'Valid Parentheses', 'Two Sum',
        'Median of Two Sorted Arrays', 'Course Schedule',
      ]);
  });
});

describe('filterSortProblems — non-mutation', () => {
  it('does not reorder or mutate the input array', () => {
    const before = sample.map((e) => e.title);
    filterSortProblems(sample, controls({ sort: s('title', 'asc') }));
    filterSortProblems(sample, controls({ sort: s('recent', 'asc') }));
    expect(sample.map((e) => e.title)).toEqual(before);
  });
});

describe('sort helpers — select / toggle / normalize', () => {
  it('selectOrResetSort picks an INACTIVE field at its natural default direction', () => {
    // from the default (recent), clicking another field selects it.
    expect(selectOrResetSort(DEFAULT_SORT, 'difficulty')).toEqual(s('difficulty', 'asc'));
    expect(selectOrResetSort(DEFAULT_SORT, 'title')).toEqual(s('title', 'asc'));
  });

  it('selectOrResetSort RESETS to the default when the active field is re-clicked (undo)', () => {
    // on difficulty-asc, clicking Difficulty again → back to the default sort.
    expect(selectOrResetSort(s('difficulty', 'asc'), 'difficulty')).toEqual(DEFAULT_SORT);
    // even after flipping its direction, re-clicking the active field resets.
    expect(selectOrResetSort(s('title', 'desc'), 'title')).toEqual(DEFAULT_SORT);
    // clicking the active DEFAULT field (recent) is a harmless no-op (stays default).
    expect(selectOrResetSort(DEFAULT_SORT, 'recent')).toEqual(DEFAULT_SORT);
  });

  it('toggleSortDirection flips an already-active field', () => {
    expect(toggleSortDirection(s('recent', 'desc'), 'recent')).toEqual(s('recent', 'asc'));
    expect(toggleSortDirection(s('recent', 'asc'), 'recent')).toEqual(s('recent', 'desc'));
  });

  it('toggleSortDirection on an inactive field activates it at the opposite of default (never a dead click)', () => {
    // default for difficulty is asc → caret from another field lands on desc.
    expect(toggleSortDirection(s('recent', 'desc'), 'difficulty')).toEqual(s('difficulty', 'desc'));
    // default for recent is desc → caret lands on asc.
    expect(toggleSortDirection(s('title', 'asc'), 'recent')).toEqual(s('recent', 'asc'));
  });

  it('normalizeSort upgrades a legacy bare-string value to its default direction', () => {
    expect(normalizeSort('difficulty')).toEqual(s('difficulty', 'asc'));
    expect(normalizeSort('recent')).toEqual(s('recent', 'desc'));
  });

  it('normalizeSort passes a valid {key,direction} through', () => {
    expect(normalizeSort({ key: 'title', direction: 'desc' })).toEqual(s('title', 'desc'));
  });

  it('normalizeSort fails safe to the default on junk / partial values', () => {
    expect(normalizeSort(undefined)).toEqual(DEFAULT_SORT);
    expect(normalizeSort(null)).toEqual(DEFAULT_SORT);
    expect(normalizeSort('bogus')).toEqual(DEFAULT_SORT);
    expect(normalizeSort({ key: 'bogus', direction: 'asc' })).toEqual(DEFAULT_SORT);
    // valid key but junk direction → default direction for that key.
    expect(normalizeSort({ key: 'title', direction: 'sideways' })).toEqual(s('title', 'asc'));
  });
});

describe('collectPatternFacets (R3.2)', () => {
  it('returns only patterns present, de-duped, in canonical order', () => {
    // Present across the sample: Hash Map, Two Pointers, Stack, DFS, Graph, BFS,
    // Binary Search — returned in the canonical ProblemPattern order.
    expect(collectPatternFacets(sample)).toEqual([
      'Hash Map', 'Two Pointers', 'Binary Search', 'BFS', 'DFS', 'Stack', 'Graph',
    ]);
  });

  it('empty input yields no facets', () => {
    expect(collectPatternFacets([])).toEqual([]);
  });
});

describe('leetcodeHref (R2.3/R2.4)', () => {
  it('returns null for missing / empty / whitespace url', () => {
    expect(leetcodeHref('')).toBeNull();
    expect(leetcodeHref(undefined)).toBeNull();
    expect(leetcodeHref(null)).toBeNull();
    expect(leetcodeHref('   ')).toBeNull();
  });

  it('passes a real url through unchanged (no reconstruction)', () => {
    expect(leetcodeHref('https://leetcode.com/problems/two-sum/'))
      .toBe('https://leetcode.com/problems/two-sum/');
  });
});

describe('isSortKey (persistence fail-safe)', () => {
  it('true for the three valid keys', () => {
    for (const k of ['recent', 'difficulty', 'title'] as SortKey[]) {
      expect(isSortKey(k)).toBe(true);
    }
  });

  it('false for unknown / empty / undefined', () => {
    expect(isSortKey('bogus')).toBe(false);
    expect(isSortKey('')).toBe(false);
    expect(isSortKey(undefined)).toBe(false);
    expect(isSortKey(null)).toBe(false);
  });
});
