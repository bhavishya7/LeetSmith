import { describe, it, expect } from 'vitest';
import {
  slugFromUrl,
  migrate,
  sameCalendarDay,
  shouldReplaceLatest,
  unionPatterns,
  computeBestAttemptIndex,
  complexityRank,
} from '../progress-records';
import { PROBLEM_RECORD_SCHEMA_VERSION } from '../../types';
import type { ProblemRecord, Attempt } from '../../types';

/**
 * Unit tests for the PURE helpers in progress-records.ts. The async save/get
 * paths hit chrome.storage and are integration-shaped; the interesting logic
 * (append-vs-replace, best-attempt selection, complexity ordering, schema
 * migration) is all in these pure functions.
 */

function attempt(o: Attempt['outcome'], overrides: Partial<Attempt> = {}): Attempt {
  return {
    date: Date.parse('2026-09-10T12:00:00'),
    outcome: o,
    approachSummary: 'hash map',
    solutionSummary: 'notes',
    complexity: { time: 'O(n)', space: 'O(n)' },
    hintsUsed: 0,
    ...overrides,
  };
}

describe('slugFromUrl', () => {
  it('extracts the slug from a normalized problem URL', () => {
    expect(slugFromUrl('https://leetcode.com/problems/two-sum/')).toBe('two-sum');
  });
  it('extracts the slug even with a sub-path or query', () => {
    expect(slugFromUrl('https://leetcode.com/problems/two-sum/submissions/?tab=x')).toBe('two-sum');
  });
  it('falls back to the raw string when it is not a problem URL', () => {
    expect(slugFromUrl('not-a-url')).toBe('not-a-url');
  });
});

describe('migrate', () => {
  it('brings a record that lacks a schemaVersion up to the current version', () => {
    const legacy = { slug: 'x', attempts: [] } as unknown as ProblemRecord;
    expect(migrate(legacy).schemaVersion).toBe(PROBLEM_RECORD_SCHEMA_VERSION);
  });
  it('leaves a current-version record unchanged (idempotent)', () => {
    const current = {
      slug: 'x', schemaVersion: PROBLEM_RECORD_SCHEMA_VERSION, attempts: [],
    } as unknown as ProblemRecord;
    expect(migrate(current)).toEqual(current);
  });

  // v1 → v2 (progress-insights-overhaul): two new per-Attempt fields.
  describe('v1 → v2', () => {
    it('defaults an old v1 attempt usedActions to [] and leaves optimalComplexity absent', () => {
      const v1 = {
        slug: 'two-sum', schemaVersion: 1,
        attempts: [attempt('solved')], // no usedActions / optimalComplexity
      } as unknown as ProblemRecord;
      const migrated = migrate(v1);
      expect(migrated.schemaVersion).toBe(2);
      expect(migrated.attempts[0].usedActions).toEqual([]);
      expect('optimalComplexity' in migrated.attempts[0]).toBe(false);
    });

    it('does NOT mis-score / fabricate: the old attempt is "none recorded", not a struggle signal', () => {
      const v1 = {
        slug: 'two-sum', schemaVersion: 1, attempts: [attempt('solved', { hintsUsed: 0 })],
      } as unknown as ProblemRecord;
      const a = migrate(v1).attempts[0];
      expect(a.usedActions).toEqual([]);              // empty ⇒ zero tool-depth downstream
      expect(a.optimalComplexity).toBeUndefined();    // absent ⇒ never flagged suboptimal
    });

    it('preserves an attempt that already has usedActions (no clobber)', () => {
      const v1 = {
        slug: 'two-sum', schemaVersion: 1,
        attempts: [attempt('solved', { usedActions: ['GET_HINT'] })],
      } as unknown as ProblemRecord;
      expect(migrate(v1).attempts[0].usedActions).toEqual(['GET_HINT']);
    });

    it('is idempotent on a v2 record (second migrate is a no-op)', () => {
      const v1 = {
        slug: 'two-sum', schemaVersion: 1, attempts: [attempt('solved')],
      } as unknown as ProblemRecord;
      const once = migrate(v1);
      expect(migrate(once)).toEqual(once);
    });
  });
});

describe('sameCalendarDay', () => {
  it('is true for two times on the same local day', () => {
    const morning = Date.parse('2026-09-10T08:00:00');
    const evening = Date.parse('2026-09-10T23:30:00');
    expect(sameCalendarDay(morning, evening)).toBe(true);
  });
  it('is false across a day boundary', () => {
    const d1 = Date.parse('2026-09-10T23:59:00');
    const d2 = Date.parse('2026-09-11T00:01:00');
    expect(sameCalendarDay(d1, d2)).toBe(false);
  });
});

describe('shouldReplaceLatest', () => {
  it('is false when there is no previous attempt', () => {
    expect(shouldReplaceLatest(undefined, attempt('solved'))).toBe(false);
  });

  it('replaces when same day + unchanged approach + unchanged complexity', () => {
    const latest = attempt('solved');
    const incoming = attempt('solved', { date: Date.parse('2026-09-10T18:00:00') });
    expect(shouldReplaceLatest(latest, incoming)).toBe(true);
  });

  it('appends (no replace) when the approach changed', () => {
    const latest = attempt('solved', { approachSummary: 'brute force' });
    const incoming = attempt('solved', { approachSummary: 'hash map' });
    expect(shouldReplaceLatest(latest, incoming)).toBe(false);
  });

  it('appends when the complexity changed', () => {
    const latest = attempt('attempted', { complexity: { time: 'O(n^2)', space: 'O(1)' } });
    const incoming = attempt('solved', { complexity: { time: 'O(n)', space: 'O(n)' } });
    expect(shouldReplaceLatest(latest, incoming)).toBe(false);
  });

  it('appends when it is a different calendar day even if identical otherwise', () => {
    const latest = attempt('solved', { date: Date.parse('2026-09-10T12:00:00') });
    const incoming = attempt('solved', { date: Date.parse('2026-09-11T12:00:00') });
    expect(shouldReplaceLatest(latest, incoming)).toBe(false);
  });
});

describe('unionPatterns', () => {
  it('merges preserving order, dropping duplicates', () => {
    expect(unionPatterns(['Hash Map', 'Two Pointers'], ['Two Pointers', 'DFS']))
      .toEqual(['Hash Map', 'Two Pointers', 'DFS']);
  });
});

describe('complexityRank', () => {
  it('orders common Big-O classes from cheapest to most expensive', () => {
    const ranks = ['O(1)', 'O(log n)', 'O(n)', 'O(n log n)', 'O(n^2)', 'O(n^3)', 'O(2^n)', 'O(n!)']
      .map(complexityRank);
    for (let i = 1; i < ranks.length; i++) {
      expect(ranks[i]).toBeGreaterThan(ranks[i - 1]);
    }
  });

  it('is case- and whitespace-insensitive', () => {
    expect(complexityRank('o( n )')).toBe(complexityRank('O(n)'));
  });

  it('sorts an unknown notation to the middle (never a false best)', () => {
    const unknown = complexityRank('O(sqrt n)');
    expect(unknown).toBeGreaterThan(complexityRank('O(n)'));       // worse than O(n)
    expect(unknown).toBeLessThan(complexityRank('O(n^2)'));        // better than O(n^2)
  });
});

describe('computeBestAttemptIndex', () => {
  it('returns -1 for no attempts', () => {
    expect(computeBestAttemptIndex([])).toBe(-1);
  });

  it('prefers a solved attempt with the lowest complexity', () => {
    const attempts = [
      attempt('attempted', { complexity: { time: 'O(1)', space: 'O(1)' } }), // cheapest but not solved
      attempt('solved', { complexity: { time: 'O(n^2)', space: 'O(1)' } }),
      attempt('solved', { complexity: { time: 'O(n)', space: 'O(n)' } }),    // best solved
    ];
    expect(computeBestAttemptIndex(attempts)).toBe(2);
  });

  it('tie-breaks equal-complexity solved attempts by fewest hints', () => {
    const attempts = [
      attempt('solved', { complexity: { time: 'O(n)', space: 'O(n)' }, hintsUsed: 3 }),
      attempt('solved', { complexity: { time: 'O(n)', space: 'O(n)' }, hintsUsed: 1 }),
    ];
    expect(computeBestAttemptIndex(attempts)).toBe(1);
  });

  it('falls back to the best among all when nothing is solved', () => {
    const attempts = [
      attempt('attempted', { complexity: { time: 'O(n^2)', space: 'O(1)' } }),
      attempt('gave-up', { complexity: { time: 'O(n)', space: 'O(n)' } }), // cheaper
    ];
    expect(computeBestAttemptIndex(attempts)).toBe(1);
  });
});
