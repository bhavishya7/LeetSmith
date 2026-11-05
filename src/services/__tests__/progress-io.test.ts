import { describe, it, expect } from 'vitest';
import {
  buildProgressReportMarkdown,
  buildProgressExport,
  serializeProgressExport,
  parseImport,
  sanitizeRecord,
  sanitizeUsedActions,
  sanitizeComplexity,
  mergeRecords,
  EXPORT_FORMAT_ID,
  EXPORT_FORMAT_VERSION,
  MAX_IMPORT_BYTES,
  MAX_RECORDS,
} from '../progress-io';
import { migrate } from '../progress-records';
import { computeInsights } from '../progress-analytics';
import { PROBLEM_RECORD_SCHEMA_VERSION } from '../../types';
import type { ProblemRecord, Attempt } from '../../types';

/**
 * Tests for progress-io.ts — the pure export/import logic. Split into:
 *   - FUNCTIONAL: Markdown builder, JSON serializer, parseImport accept/reject,
 *     merge (add / newer-wins / skip-older / idempotent).
 *   - SECURITY (R7.2, required): XSS neutralization, prototype-pollution
 *     resistance, DoS caps, derived-field recomputation, fail-closed.
 */

function attempt(overrides: Partial<Attempt> = {}): Attempt {
  return {
    date: Date.parse('2026-09-10T12:00:00Z'),
    outcome: 'solved',
    approachSummary: 'hash map',
    solutionSummary: 'one pass',
    complexity: { time: 'O(n)', space: 'O(n)' },
    hintsUsed: 1,
    language: 'python',
    ...overrides,
  };
}

function record(overrides: Partial<ProblemRecord> = {}): ProblemRecord {
  return {
    schemaVersion: PROBLEM_RECORD_SCHEMA_VERSION,
    slug: 'two-sum',
    url: 'https://leetcode.com/problems/two-sum/',
    title: 'Two Sum',
    difficulty: 'Easy',
    patterns: ['Hash Map'],
    attempts: [attempt()],
    bestAttemptIndex: 0,
    firstSolvedAt: Date.parse('2026-09-10T12:00:00Z'),
    lastUpdatedAt: Date.parse('2026-09-10T12:00:00Z'),
    notes: 'A study note.',
    ...overrides,
  };
}

// ===========================================================================
// FUNCTIONAL
// ===========================================================================

describe('buildProgressReportMarkdown', () => {
  it('handles an empty record set', () => {
    const md = buildProgressReportMarkdown([], Date.parse('2026-09-27T00:00:00Z'));
    expect(md).toContain('# LeetSmith Progress — 2026-09-27');
    expect(md).toContain('No saved problems yet');
  });

  it('includes a summary header and per-problem detail with the attempts timeline', () => {
    const recs = [
      record({ slug: 'two-sum', title: 'Two Sum' }),
      record({ slug: 'add-two', title: 'Add Two Numbers', difficulty: 'Medium', patterns: ['Linked List'], lastUpdatedAt: Date.parse('2026-09-11T12:00:00Z') }),
    ];
    const md = buildProgressReportMarkdown(recs, Date.parse('2026-09-27T00:00:00Z'));
    expect(md).toContain('## Summary');
    expect(md).toContain('Problems tracked: 2');
    // Per-problem detail
    expect(md).toContain('# Two Sum (Easy)');
    expect(md).toContain('# Add Two Numbers (Medium)');
    // Attempts timeline line
    expect(md).toContain('### History');
    expect(md).toContain('solved — best');
    expect(md).toContain('O(n) time / O(n) space');
    // The saved note
    expect(md).toContain('A study note.');
  });
});

describe('buildProgressExport / serializeProgressExport', () => {
  it('builds a versioned envelope and does NOT include a progress_index', () => {
    const env = buildProgressExport([record()], 12345);
    expect(env.format).toBe(EXPORT_FORMAT_ID);
    expect(env.formatVersion).toBe(EXPORT_FORMAT_VERSION);
    expect(env.schemaVersion).toBe(PROBLEM_RECORD_SCHEMA_VERSION);
    expect(env.exportedAt).toBe(12345);
    expect(env.records).toHaveLength(1);
    expect(env as unknown as Record<string, unknown>).not.toHaveProperty('progress_index');
  });

  it('serializes to valid JSON that round-trips through parseImport', () => {
    const json = serializeProgressExport([record()]);
    const result = parseImport(json);
    expect(result.error).toBeUndefined();
    expect(result.records).toHaveLength(1);
    expect(result.records[0].slug).toBe('two-sum');
  });
});

describe('parseImport — accept', () => {
  it('accepts a good export and migrates records', () => {
    const json = serializeProgressExport([record()]);
    const result = parseImport(json);
    expect(result.error).toBeUndefined();
    expect(result.skipped).toBe(0);
    expect(result.records[0].schemaVersion).toBe(PROBLEM_RECORD_SCHEMA_VERSION);
  });
});

describe('parseImport — reject (hard fail, never throws)', () => {
  it('rejects malformed JSON', () => {
    const result = parseImport('{ not json');
    expect(result.error).toBeDefined();
    expect(result.records).toHaveLength(0);
  });

  it('rejects a wrong/foreign envelope', () => {
    const result = parseImport(JSON.stringify({ format: 'something-else', records: [] }));
    expect(result.error).toBeDefined();
  });

  it('rejects when records is not an array', () => {
    const result = parseImport(JSON.stringify({ format: EXPORT_FORMAT_ID, formatVersion: 1, records: {} }));
    expect(result.error).toBeDefined();
  });

  it('rejects an unsupported (future) format version', () => {
    const result = parseImport(JSON.stringify({ format: EXPORT_FORMAT_ID, formatVersion: 999, records: [] }));
    expect(result.error).toBeDefined();
  });
});

describe('mergeRecords', () => {
  it('adds a brand-new slug', () => {
    const { merged, summary } = mergeRecords([], [record()]);
    expect(merged).toHaveLength(1);
    expect(summary).toEqual({ added: 1, updated: 0, skipped: 0 });
  });

  it('newer-wins: replaces when incoming lastUpdatedAt is later', () => {
    const older = record({ lastUpdatedAt: 1000, notes: 'old' });
    const newer = record({ lastUpdatedAt: 2000, notes: 'new' });
    const { merged, summary } = mergeRecords([older], [newer]);
    expect(merged[0].notes).toBe('new');
    expect(summary).toEqual({ added: 0, updated: 1, skipped: 0 });
  });

  it('skip-older: keeps existing when incoming is older', () => {
    const existing = record({ lastUpdatedAt: 2000, notes: 'keep' });
    const incoming = record({ lastUpdatedAt: 1000, notes: 'discard' });
    const { merged, summary } = mergeRecords([existing], [incoming]);
    expect(merged[0].notes).toBe('keep');
    expect(summary).toEqual({ added: 0, updated: 0, skipped: 1 });
  });

  it('is idempotent: re-merging the same records changes nothing', () => {
    const recs = [record()];
    const once = mergeRecords([], recs);
    const twice = mergeRecords(once.merged, recs);
    expect(twice.summary).toEqual({ added: 0, updated: 0, skipped: 1 });
    expect(twice.merged).toEqual(once.merged);
  });
});

// ===========================================================================
// SECURITY (R7.2 — required)
// ===========================================================================

describe('security — XSS neutralization (R5.1)', () => {
  it('neutralizes an <img onerror> payload in notes so no tag can form', () => {
    const malicious = record({ notes: '<img src=x onerror="alert(1)">' });
    const result = parseImport(serializeProgressExport([malicious]));
    const notes = result.records[0].notes;
    // The tag-forming `<` is stripped, so no element can ever open. The bare
    // `>` may remain (it's inert text and legitimate as an operator), but
    // there must be no tag-opening sequence.
    expect(notes).not.toMatch(/<[a-zA-Z/]/);
    expect(notes).not.toContain('<img');
  });

  it('neutralizes a <script> payload in the title', () => {
    const sane = sanitizeRecord({ ...record(), title: '<script>steal()</script>' });
    expect(sane?.title).not.toMatch(/<[a-zA-Z/]/);
    expect(sane?.title).not.toContain('<script');
    expect(sane?.title).not.toContain('</script');
  });

  it('neutralizes a javascript: URL / anchor tag in approachSummary', () => {
    const sane = sanitizeRecord({
      ...record(),
      attempts: [{ ...attempt(), approachSummary: `"><a href="javascript:evil()">x</a>` }],
    });
    const a = sane!.attempts[0].approachSummary;
    // No tag can form without a tag-opening sequence; the javascript: URL is
    // now inert text.
    expect(a).not.toMatch(/<[a-zA-Z/]/);
    expect(a).not.toContain('<a href');
    expect(a).not.toContain('</a');
  });

  it('is idempotent on legit prose with apostrophes/ampersands (no progressive corruption)', () => {
    const text = `the element's key & the array's length < n`;
    const once = sanitizeRecord({ ...record(), notes: text })!.notes;
    const twice = sanitizeRecord({ ...record(), notes: once })!.notes;
    // Apostrophes, &, AND the bare comparison operator `<` are all preserved
    // verbatim now (B20): a `<` followed by a space is not tag-forming.
    expect(once).toBe(`the element's key & the array's length < n`);
    expect(twice).toBe(once); // re-sanitizing changes nothing
  });
});

// ===========================================================================
// B20 — comparison operators in notes survive import (DATA LOSS regression)
// ===========================================================================

describe('B20 — comparison operators in notes are NOT stripped (data-loss fix)', () => {
  it('preserves `<`, `>`, `<=`, `>=` used as operators in a study note', () => {
    const notes = [
      'Binary search:',
      'while (left < right) { ... }',
      'if (nums[mid] > nums[right]) left = mid + 1;',
      'guard: arr[i] <= arr[j] && k >= 0',
    ].join('\n');
    const sane = sanitizeRecord({ ...record(), notes })!;
    // Every operator survives UNCHANGED — this is the exact corruption B20 fixed.
    expect(sane.notes).toContain('left < right');
    expect(sane.notes).toContain('nums[mid] > nums[right]');
    expect(sane.notes).toContain('arr[i] <= arr[j] && k >= 0');
    // And nothing was silently removed.
    expect(sane.notes).toBe(notes);
  });

  it('survives a full export -> import round-trip without losing operators', () => {
    const notes = 'left < right, mid > lo, i <= j, n >= 0';
    const { records, error } = parseImport(serializeProgressExport([record({ notes })]));
    expect(error).toBeUndefined();
    expect(records[0].notes).toBe(notes);
  });

  it('still neutralizes a real <script>-forming string even while keeping operators', () => {
    const notes = 'left < right then <script>steal()</script> but mid > lo';
    const sane = sanitizeRecord({ ...record(), notes })!;
    // Operators kept…
    expect(sane.notes).toContain('left < right');
    expect(sane.notes).toContain('mid > lo');
    // …but no tag can form.
    expect(sane.notes).not.toMatch(/<[a-zA-Z/]/);
    expect(sane.notes).not.toContain('<script');
    expect(sane.notes).not.toContain('</script');
  });

  it('is idempotent: a mixed operator + tag string is stable across re-imports', () => {
    const notes = 'a < b and <div onclick=x> and c > d';
    const once = sanitizeRecord({ ...record(), notes })!.notes;
    const twice = sanitizeRecord({ ...record(), notes: once })!.notes;
    expect(twice).toBe(once);          // second pass changes nothing
    expect(once).toContain('a < b');   // operator kept
    expect(once).toContain('c > d');   // operator kept
    expect(once).not.toMatch(/<[a-zA-Z/]/); // tag neutralized
  });
});

describe('security — prototype pollution (R5.3)', () => {
  it('does NOT pollute Object.prototype via a __proto__ payload', () => {
    const payload = JSON.stringify({
      format: EXPORT_FORMAT_ID,
      formatVersion: 1,
      records: [
        // A record carrying a __proto__ key and a polluting nested object.
        JSON.parse('{"slug":"two-sum","__proto__":{"polluted":true},"attempts":[]}'),
      ],
    });
    parseImport(payload);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect((Object.prototype as unknown as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('ignores a constructor/prototype key rather than copying it', () => {
    const sane = sanitizeRecord(JSON.parse('{"slug":"two-sum","constructor":"boom","prototype":"boom","attempts":[]}'));
    expect(sane).not.toBeNull();
    expect((sane as unknown as Record<string, unknown>).constructor).toBe(Object); // still the real constructor
  });
});

describe('security — DoS caps (R5.2)', () => {
  it('rejects an oversized file before parsing', () => {
    const huge = 'x'.repeat(MAX_IMPORT_BYTES + 1);
    const result = parseImport(huge);
    expect(result.error).toMatch(/too large/i);
    expect(result.records).toHaveLength(0);
  });

  it('rejects a file with too many records', () => {
    const records = Array.from({ length: MAX_RECORDS + 1 }, (_, i) => ({ slug: `p-${i}`, attempts: [] }));
    const result = parseImport(JSON.stringify({ format: EXPORT_FORMAT_ID, formatVersion: 1, records }));
    expect(result.error).toMatch(/too many/i);
  });

  it('caps attempts per record', () => {
    const attempts = Array.from({ length: 1000 }, () => attempt());
    const sane = sanitizeRecord({ ...record(), attempts });
    expect(sane!.attempts.length).toBeLessThanOrEqual(500);
  });

  it('truncates an over-long string field', () => {
    const sane = sanitizeRecord({ ...record(), title: 'a'.repeat(10_000) });
    expect(sane!.title.length).toBeLessThanOrEqual(2_000);
  });
});

describe('security — type confusion & derived-field integrity (R5.4)', () => {
  it('rejects a bad slug (fails the slug grammar)', () => {
    expect(sanitizeRecord({ ...record(), slug: '../etc/passwd' })).toBeNull();
    expect(sanitizeRecord({ ...record(), slug: 'Two Sum' })).toBeNull();
  });

  it('defaults an out-of-enum difficulty to Medium', () => {
    const sane = sanitizeRecord({ ...record(), difficulty: 'Impossible' });
    expect(sane!.difficulty).toBe('Medium');
  });

  it('filters patterns to the known vocabulary', () => {
    const sane = sanitizeRecord({ ...record(), patterns: ['Hash Map', 'Nonsense', 42, 'DFS'] });
    expect(sane!.patterns).toEqual(['Hash Map', 'DFS']);
  });

  it('rejects NaN/Infinity/negative timestamps (falls back to sane values)', () => {
    const sane = sanitizeRecord({
      ...record(),
      lastUpdatedAt: Infinity,
      firstSolvedAt: -5,
      attempts: [{ ...attempt(), date: Date.parse('2026-09-10T12:00:00Z') }],
    });
    expect(Number.isFinite(sane!.lastUpdatedAt)).toBe(true);
    expect(sane!.firstSolvedAt).toBeGreaterThan(0);
  });

  it('RECOMPUTES bestAttemptIndex, ignoring an out-of-bounds file value', () => {
    const sane = sanitizeRecord({
      ...record(),
      bestAttemptIndex: 999, // out of bounds — must be ignored
      attempts: [
        attempt({ outcome: 'attempted', complexity: { time: 'O(n^2)', space: 'O(1)' } }),
        attempt({ outcome: 'solved', complexity: { time: 'O(n)', space: 'O(n)' } }),
      ],
    });
    // The solved O(n) attempt (index 1) is best; never the file's 999.
    expect(sane!.bestAttemptIndex).toBe(1);
  });
});

// ===========================================================================
// ROUND-TRIP / NO-DATA-LOSS (models the real exported-file shape, no Node APIs)
// ===========================================================================

describe('round-trip — export -> import preserves data and is idempotent', () => {
  // A record modeled on real study notes: markdown, apostrophes, an ampersand,
  // and a literal `>` (as in "timestamp > mid") — the content that exposed the
  // earlier non-idempotent-escaping bug.
  const realistic = record({
    slug: 'time-based-key-value-store',
    title: '981. Time Based Key-Value Store',
    difficulty: 'Medium',
    patterns: ['Hash Map', 'Binary Search'],
    notes: "## Notes\n\nAppend to the key's list & binary-search on get.\nAdjust pointers when `timestamp > mid` to land on the floor value.",
    attempts: [attempt({
      approachSummary: "Map each key to a sorted list; binary search for the largest timestamp <= target.",
      outcome: 'solved',
      complexity: { time: 'O(log N)', space: 'O(N)' },
    })],
    // Real epoch-ms values (the sanitizer rejects out-of-range timestamps like
    // 1000ms, which fall before the year-2000 floor — see sanitizeTimestamp).
    lastUpdatedAt: Date.parse('2026-09-28T12:00:00Z'),
    firstSolvedAt: Date.parse('2026-09-27T12:00:00Z'),
  });

  it('round-trips every field verbatim (operators + apostrophes + ampersands all kept)', () => {
    const json = serializeProgressExport([realistic]);
    const { records, skipped, error } = parseImport(json);
    expect(error).toBeUndefined();
    expect(skipped).toBe(0);
    const r = records[0];

    expect(r.slug).toBe(realistic.slug);
    expect(r.title).toBe(realistic.title);
    expect(r.patterns).toEqual(realistic.patterns);
    expect(r.firstSolvedAt).toBe(realistic.firstSolvedAt);
    expect(r.lastUpdatedAt).toBe(realistic.lastUpdatedAt);
    // The apostrophe, ampersand AND the `>` comparison operator all survive
    // verbatim now (B20 — a `>` / a `<` used as an operator is not a tag).
    expect(r.notes).toContain("the key's list & binary-search");
    expect(r.notes).toContain('timestamp > mid'); // the operator is preserved
    expect(r.notes).toBe(realistic.notes);        // whole note is unchanged
    expect(r.notes).not.toContain('&#39;');       // NOT escaped
    expect(r.notes).not.toContain('&amp;');       // NOT escaped
  });

  it('re-importing the same export is a pure no-op (0 added, 0 updated)', () => {
    const existing = parseImport(serializeProgressExport([realistic])).records;
    const incoming = parseImport(serializeProgressExport([realistic])).records;
    const { merged, summary } = mergeRecords(existing, incoming);
    expect(summary).toEqual({ added: 0, updated: 0, skipped: 1 });
    expect(merged).toEqual(existing);
  });

  it('import never touches an unrelated existing record', () => {
    const unrelated = record({ slug: 'untouched', title: 'Keep Me', notes: 'preserve', lastUpdatedAt: 50 });
    const incoming = parseImport(serializeProgressExport([realistic])).records;
    const { merged, summary } = mergeRecords([unrelated], incoming);
    expect(merged.find(r => r.slug === 'untouched')).toEqual(unrelated);
    expect(summary.added).toBe(1);
  });

  it('is stable across repeated import cycles (sanitize is idempotent)', () => {
    const first = parseImport(serializeProgressExport([realistic])).records;
    const second = parseImport(serializeProgressExport(first, 0)).records;
    expect(second).toEqual(first);
  });
});

describe('security — hardening follow-ups (#1 non-JSON, #2 global attempts, #5 url)', () => {
  it('#1 gives a friendly message for a clearly-non-JSON file', () => {
    const result = parseImport('# LeetSmith Progress\n\nthis is markdown, not json');
    expect(result.error).toMatch(/doesn't look like a JSON file/i);
    expect(result.records).toHaveLength(0);
  });

  it('#1 still rejects malformed JSON that starts like JSON', () => {
    const result = parseImport('{ "format": broken');
    expect(result.error).toMatch(/isn't valid JSON/i);
  });

  it('#2 rejects a file whose total declared attempts exceed the global cap', () => {
    // A handful of records each declaring a massive attempts[] array.
    const records = Array.from({ length: 200 }, (_, i) => ({
      slug: `p-${i}`,
      attempts: new Array(500).fill({ date: Date.parse('2026-09-10T12:00:00Z'), outcome: 'solved' }),
    }));
    const result = parseImport(JSON.stringify({ format: EXPORT_FORMAT_ID, formatVersion: 1, records }));
    expect(result.error).toMatch(/too many attempts/i);
    expect(result.records).toHaveLength(0);
  });

  it('#5 rebuilds a javascript: url from the slug (never trusts the file)', () => {
    const sane = sanitizeRecord({ ...record(), slug: 'two-sum', url: 'javascript:stealData()' });
    expect(sane!.url).toBe('https://leetcode.com/problems/two-sum/');
  });

  it('#5 rebuilds an off-domain or http url', () => {
    expect(sanitizeRecord({ ...record(), slug: 'two-sum', url: 'http://evil.com/problems/two-sum/' })!.url)
      .toBe('https://leetcode.com/problems/two-sum/');
    expect(sanitizeRecord({ ...record(), slug: 'two-sum', url: 'https://evil.com/problems/two-sum/' })!.url)
      .toBe('https://leetcode.com/problems/two-sum/');
  });

  it('#5 rebuilds a url whose slug does not match the record slug', () => {
    const sane = sanitizeRecord({ ...record(), slug: 'two-sum', url: 'https://leetcode.com/problems/some-other-problem/' });
    expect(sane!.url).toBe('https://leetcode.com/problems/two-sum/');
  });

  it('#5 keeps a legitimate LeetCode problem url (incl. sub-paths)', () => {
    const sane = sanitizeRecord({ ...record(), slug: 'two-sum', url: 'https://leetcode.com/problems/two-sum/description/' });
    expect(sane!.url).toBe('https://leetcode.com/problems/two-sum/description/');
  });
});

// ===========================================================================
// v2 (progress-insights-overhaul) — R4b: usedActions + optimalComplexity MUST
// round-trip; the import sanitizer is the easy-to-miss third touch-point.
// ===========================================================================

describe('v2 — sanitizeUsedActions (untrusted allowlist, R4b.3)', () => {
  it('keeps only known ActionType strings, dedupes, defaults [] for garbage', () => {
    expect(sanitizeUsedActions(['GET_HINT', 'CHECK_APPROACH', 'GET_HINT'])).toEqual(['GET_HINT', 'CHECK_APPROACH']);
    expect(sanitizeUsedActions(['GET_HINT', 'NOT_A_REAL_ACTION', 42, null, {}])).toEqual(['GET_HINT']);
    expect(sanitizeUsedActions('GET_HINT')).toEqual([]);   // not an array
    expect(sanitizeUsedActions(undefined)).toEqual([]);
    expect(sanitizeUsedActions(null)).toEqual([]);
    expect(sanitizeUsedActions({ 0: 'GET_HINT' })).toEqual([]); // object, not array
  });

  it('cannot exceed the vocabulary size even with a flood of duplicates', () => {
    const flood = new Array(1000).fill('GET_HINT');
    expect(sanitizeUsedActions(flood)).toEqual(['GET_HINT']);
  });
});

describe('v2 — sanitizeComplexity (absent ⇒ null, never fabricate)', () => {
  it('returns a clean pair when both fields are present', () => {
    expect(sanitizeComplexity({ time: 'O(n)', space: 'O(1)' })).toEqual({ time: 'O(n)', space: 'O(1)' });
  });
  it('returns null for a missing/half/garbage value (so the flag never fires on it)', () => {
    expect(sanitizeComplexity(undefined)).toBeNull();
    expect(sanitizeComplexity(null)).toBeNull();
    expect(sanitizeComplexity({ time: 'O(n)' })).toBeNull();
    expect(sanitizeComplexity({ time: '', space: '' })).toBeNull();
    expect(sanitizeComplexity('O(n)')).toBeNull();
  });
});

describe('v2 — R4b round-trip of the new Attempt fields', () => {
  const withV2 = record({
    slug: 'course-schedule',
    title: 'Course Schedule',
    attempts: [attempt({
      usedActions: ['GET_HINT', 'CHECK_APPROACH', 'UNDERSTAND_SOLUTION'],
      optimalComplexity: { time: 'O(V+E)', space: 'O(V+E)' },
      chatCount: 3,
      complexity: { time: 'O(n^2)', space: 'O(1)' },
    })],
  });

  it('(a) a record WITH the new fields round-trips with them intact', () => {
    const { records, error, skipped } = parseImport(serializeProgressExport([withV2]));
    expect(error).toBeUndefined();
    expect(skipped).toBe(0);
    const a = records[0].attempts[0];
    expect(a.usedActions).toEqual(['GET_HINT', 'CHECK_APPROACH', 'UNDERSTAND_SOLUTION']);
    expect(a.optimalComplexity).toEqual({ time: 'O(V+E)', space: 'O(V+E)' });
    expect(a.chatCount).toBe(3);
  });

  it('(b) an OLD export WITHOUT the fields imports cleanly with safe defaults', () => {
    // Model a pre-v2 file: build the JSON then delete the fields from the attempt.
    const old = buildProgressExport([record({ slug: 'old-problem' })]);
    delete (old.records[0].attempts[0] as Partial<Attempt>).usedActions;
    delete (old.records[0].attempts[0] as Partial<Attempt>).optimalComplexity;
    delete (old.records[0].attempts[0] as Partial<Attempt>).chatCount;
    const { records, error } = parseImport(JSON.stringify(old));
    expect(error).toBeUndefined();
    const a = records[0].attempts[0];
    expect(a.usedActions).toEqual([]);                 // defaulted, not undefined
    expect('optimalComplexity' in a).toBe(false);      // absent ⇒ never flagged
    expect('chatCount' in a).toBe(false);              // absent ⇒ scored as 0
  });

  it('(c) export→import→export→import is idempotent WITH the new fields', () => {
    const first = parseImport(serializeProgressExport([withV2])).records;
    const second = parseImport(serializeProgressExport(first, 0)).records;
    expect(second).toEqual(first);
  });

  it('sanitizes an untrusted usedActions array on import (allowlist, not pass-through)', () => {
    const hostile = buildProgressExport([record({ slug: 'two-sum' })]);
    (hostile.records[0].attempts[0] as { usedActions: unknown }).usedActions =
      ['GET_HINT', '<script>', 'DROP TABLE', 7];
    const { records } = parseImport(JSON.stringify(hostile));
    expect(records[0].attempts[0].usedActions).toEqual(['GET_HINT']);
  });
});

describe('v2 — R4b.4 convergence: storage-read default === import default', () => {
  it('an old field-less attempt ends up IDENTICAL through migrate() and through the importer', () => {
    // The same old (v1, field-less) attempt, fed to both paths.
    const oldAttempt: Attempt = attempt({ slug: undefined } as Partial<Attempt>);
    delete (oldAttempt as Partial<Attempt>).usedActions;
    delete (oldAttempt as Partial<Attempt>).optimalComplexity;

    // Path (2): storage-read migration of a v1 record.
    const viaMigrate = migrate({
      ...record({ schemaVersion: 1 }), attempts: [{ ...oldAttempt }],
    } as unknown as ProblemRecord).attempts[0];

    // Path (3): import sanitizer of the same old attempt.
    const old = buildProgressExport([{ ...record(), attempts: [{ ...oldAttempt }] }]);
    delete (old.records[0].attempts[0] as Partial<Attempt>).usedActions;
    delete (old.records[0].attempts[0] as Partial<Attempt>).optimalComplexity;
    const viaImport = parseImport(JSON.stringify(old)).records[0].attempts[0];

    // Both paths must agree on the new fields (the "cannot diverge" guarantee).
    expect(viaMigrate.usedActions).toEqual(viaImport.usedActions);
    expect(viaMigrate.usedActions).toEqual([]);
    expect('optimalComplexity' in viaMigrate).toBe('optimalComplexity' in viaImport);
    expect('optimalComplexity' in viaMigrate).toBe(false);
  });
});

describe('v2 — R7b.3 acceptance: insights survive export → import into empty storage', () => {
  it('pure-function insights match after a round-trip (only wall-clock framing may shift)', () => {
    // A set rich enough to exercise trend + weakest/strongest + a flag + dashboard.
    const base = 1_760_000_000_000; // a fixed epoch in 2025, well within sane range
    const DAY = 24 * 60 * 60 * 1000;
    const mk = (i: number, pattern: ProblemRecord['patterns'][number], difficulty: ProblemRecord['difficulty'], hints: number, achieved: Attempt['complexity'], optimal?: Attempt['complexity']) =>
      record({
        slug: `prob-${i}`, title: `Problem ${i}`, difficulty, patterns: [pattern],
        firstSolvedAt: base - (20 - i) * DAY, lastUpdatedAt: base - (20 - i) * DAY, bestAttemptIndex: 0,
        attempts: [attempt({
          date: base - (20 - i) * DAY, outcome: 'solved', hintsUsed: hints, complexity: achieved,
          usedActions: ['CHECK_APPROACH'],
          ...(optimal ? { optimalComplexity: optimal } : {}),
        })],
      });
    const records = [
      mk(1, 'Dynamic Programming', 'Hard', 3, { time: 'O(n^2)', space: 'O(1)' }, { time: 'O(n)', space: 'O(n)' }),
      mk(2, 'Dynamic Programming', 'Hard', 3, { time: 'O(n)', space: 'O(n)' }),
      mk(3, 'Dynamic Programming', 'Medium', 2, { time: 'O(n)', space: 'O(n)' }),
      mk(4, 'Hash Map', 'Easy', 0, { time: 'O(n)', space: 'O(n)' }, { time: 'O(n)', space: 'O(n)' }),
      mk(5, 'Hash Map', 'Easy', 0, { time: 'O(n)', space: 'O(n)' }),
      mk(6, 'Hash Map', 'Easy', 0, { time: 'O(n)', space: 'O(n)' }),
    ];

    const before = computeInsights(records);
    // Export → import into EMPTY storage (merge against []).
    const imported = parseImport(serializeProgressExport(records)).records;
    const { merged } = mergeRecords([], imported);
    const after = computeInsights(merged);

    // Every PURE-function insight matches (trend is order-relative; flags/ranking
    // are pure over stored fields which round-trip via R4b).
    expect(after.trend.direction).toBe(before.trend.direction);
    expect(after.weakestLink?.pattern).toBe(before.weakestLink?.pattern);
    expect(after.strongestLink?.pattern).toBe(before.strongestLink?.pattern);
    expect(after.efficiencyFlags.map(f => f.slug)).toEqual(before.efficiencyFlags.map(f => f.slug));
    expect(after.dashboard.byDifficulty).toEqual(before.dashboard.byDifficulty);
    expect(after.dashboard.patternCoverage).toBe(before.dashboard.patternCoverage);
    expect(after.dashboard.reviewedCandidates).toBe(before.dashboard.reviewedCandidates);
    // Sanity: the flag actually fired (prob-1 O(n^2) vs O(n)), so this isn't vacuous.
    expect(before.efficiencyFlags.map(f => f.slug)).toContain('prob-1');
  });
});

describe('security — fail-closed / never-throws (R5.5)', () => {
  it('never throws on adversarial input', () => {
    const inputs = ['', 'null', '[]', '"string"', '{}', '{"format":"leetsage-progress"}'];
    for (const input of inputs) {
      expect(() => parseImport(input)).not.toThrow();
    }
  });

  it('skips-and-counts an unsanitizable record without aborting the batch', () => {
    const json = JSON.stringify({
      format: EXPORT_FORMAT_ID,
      formatVersion: 1,
      records: [
        record(),                    // good
        { slug: 'BAD SLUG' },        // bad → skip
        record({ slug: 'valid-two' }), // good
      ],
    });
    const result = parseImport(json);
    expect(result.error).toBeUndefined();
    expect(result.records).toHaveLength(2);
    expect(result.skipped).toBe(1);
  });
});
