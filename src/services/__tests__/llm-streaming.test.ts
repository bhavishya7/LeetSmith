import { describe, it, expect, vi, afterEach } from 'vitest';
import { streamLLMRequest } from '../llm-service';
import type { LLMRequest, LLMResponse } from '../../types';

/**
 * Tests for the buffered SSE streaming reader in streamLLMRequest (B28 + B29,
 * .kiro/specs/leetsage-streaming-truncation-fix/design.md §5).
 *
 * B28 is INTERMITTENT and network-timing-dependent — it only shows up when the
 * network happens to split a `data: {json}` SSE line across two reads, which
 * you cannot reproduce on demand. So "eyeball the extension" is NOT valid
 * verification; these tests ARE the proof. We mock `fetch` to return a Response
 * whose `body.getReader()` replays a SCRIPTED sequence of `{ done, value }`
 * chunks, where each `value` is `new TextEncoder().encode(...)` — this lets us
 * control exactly where the byte boundaries fall (including mid-line and
 * mid-UTF-8-character splits) and prove the reader reassembles them.
 */

/** Build a fake Response whose stream replays `chunks` as encoded SSE bytes. */
function mockStreamFromChunks(chunks: string[]) {
  const encoder = new TextEncoder();
  const queue = chunks.map((c) => encoder.encode(c));
  let i = 0;
  const reader = {
    read: vi.fn(async () => {
      if (i < queue.length) return { done: false, value: queue[i++] };
      return { done: true, value: undefined };
    }),
  };
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    status: 200,
    body: { getReader: () => reader },
  })) as unknown as typeof fetch);
  return reader;
}

/** Build a fake Response from RAW byte chunks (for mid-UTF-8 boundary tests). */
function mockStreamFromBytes(byteChunks: Uint8Array[]) {
  let i = 0;
  const reader = {
    read: vi.fn(async () => {
      if (i < byteChunks.length) return { done: false, value: byteChunks[i++] };
      return { done: true, value: undefined };
    }),
  };
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    status: 200,
    body: { getReader: () => reader },
  })) as unknown as typeof fetch);
  return reader;
}

/** An SSE `data:` frame carrying a content delta. */
function deltaFrame(content: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n`;
}

/** A terminal frame carrying a finish_reason (and an empty delta). */
function finishFrame(reason: LLMResponse['finishReason']): string {
  return `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: reason }] })}\n`;
}

const base: LLMRequest = {
  problemContext: {
    title: 't', url: 'u', difficulty: 'Easy', description: 'd',
    examples: [], constraints: [], testCases: [], extractedAt: 0,
  },
  actionType: 'EXPLAIN_CONCEPT',
  systemPrompt: '',
  userMessage: '',
  apiKey: 'k',
};

async function collect(req: LLMRequest): Promise<string> {
  let out = '';
  for await (const chunk of streamLLMRequest(req)) out += chunk;
  return out;
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('streamLLMRequest — buffered SSE reader (B28)', () => {
  it('reassembles a single data: line split across two reads (no dropped chunk)', async () => {
    // The whole frame for "Hello world" is split mid-JSON across two reads.
    const frame = deltaFrame('Hello world');
    const cut = Math.floor(frame.length / 2);
    mockStreamFromChunks([frame.slice(0, cut), frame.slice(cut), 'data: [DONE]\n']);

    const out = await collect(base);
    expect(out).toBe('Hello world');
  });

  it('reassembles a frame split across THREE reads', async () => {
    const frame = deltaFrame('popping them off the moment');
    const a = frame.slice(0, 10);
    const b = frame.slice(10, 25);
    const c = frame.slice(25);
    mockStreamFromChunks([a, b, c, 'data: [DONE]\n']);

    const out = await collect(base);
    expect(out).toBe('popping them off the moment');
  });

  it('decodes a multi-byte UTF-8 char split across two reads (no mojibake)', async () => {
    // "café — 日本語" contains multi-byte chars. Encode the full frame, then cut
    // the byte array at a boundary that lands in the MIDDLE of a multi-byte char
    // so the streaming decoder must hold the partial bytes across reads.
    const text = 'café — 日本語 ✅';
    const frame = deltaFrame(text);
    const bytes = new TextEncoder().encode(frame);
    const done = new TextEncoder().encode('data: [DONE]\n');
    // Cut somewhere in the Japanese run (each char is 3 bytes); pick an index
    // that is very unlikely to fall on a char boundary.
    const cut = bytes.indexOf(0xe6); // first byte of a 3-byte CJK char (日 = E6 97 A5)
    expect(cut).toBeGreaterThan(-1);
    const first = bytes.slice(0, cut + 1);  // include ONLY the first byte of the char
    const second = bytes.slice(cut + 1);
    mockStreamFromBytes([first, second, done]);

    const out = await collect(base);
    expect(out).toBe(text);
    expect(out).not.toContain('\uFFFD'); // no replacement char / mojibake
  });

  it('terminates cleanly when [DONE] is split across a read boundary', async () => {
    const frame = deltaFrame('all the content');
    // Split "data: [DONE]\n" across two reads.
    const doneLine = 'data: [DONE]\n';
    const dCut = 7; // "data: [" | "DONE]\n"
    mockStreamFromChunks([frame, doneLine.slice(0, dCut), doneLine.slice(dCut)]);

    const out = await collect(base);
    expect(out).toBe('all the content');
  });

  it('flushes a complete final line left in the buffer when the stream ends without a trailing newline', async () => {
    // The last content frame arrives WITHOUT a trailing "\n" and there is no
    // [DONE] — the old loop would leave it unprocessed in no-buffer land; the
    // new flush must still yield it.
    const frameNoNewline = `data: ${JSON.stringify({ choices: [{ delta: { content: 'final flushed chunk' } }] })}`;
    mockStreamFromChunks([deltaFrame('start '), frameNoNewline]);

    const out = await collect(base);
    expect(out).toBe('start final flushed chunk');
  });

  it('regression: a normal multi-frame stream (no splits) yields identical content', async () => {
    mockStreamFromChunks([
      deltaFrame('The '),
      deltaFrame('two '),
      deltaFrame('pointer '),
      deltaFrame('technique.'),
      'data: [DONE]\n',
    ]);

    const out = await collect(base);
    expect(out).toBe('The two pointer technique.');
  });

  it('still surfaces usage via onUsage from the final usage-only frame', async () => {
    const usageFrame = `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 34 } })}\n`;
    mockStreamFromChunks([deltaFrame('hi'), usageFrame, 'data: [DONE]\n']);

    const usage: Array<{ promptTokens: number; completionTokens: number }> = [];
    await collect({ ...base, onUsage: (u) => usage.push(u) });
    expect(usage).toEqual([{ promptTokens: 12, completionTokens: 34 }]);
  });
});

describe('streamLLMRequest — finish_reason honesty (B29)', () => {
  it("fires onFinish('length') when the stream ends on a token-cap cutoff", async () => {
    mockStreamFromChunks([
      deltaFrame('A long answer that gets cut'),
      finishFrame('length'),
      'data: [DONE]\n',
    ]);

    const reasons: Array<LLMResponse['finishReason']> = [];
    const out = await collect({ ...base, onFinish: (r) => reasons.push(r) });
    expect(out).toBe('A long answer that gets cut');
    expect(reasons).toContain('length');
  });

  it("does NOT fire 'length' on a clean 'stop' finish (no false positive)", async () => {
    mockStreamFromChunks([
      deltaFrame('A complete answer.'),
      finishFrame('stop'),
      'data: [DONE]\n',
    ]);

    const reasons: Array<LLMResponse['finishReason']> = [];
    await collect({ ...base, onFinish: (r) => reasons.push(r) });
    expect(reasons).not.toContain('length');
    expect(reasons).toContain('stop'); // it reports the clean reason, but never 'length'
  });

  it("detects a 'length' finish even when its frame is split across reads", async () => {
    // The finish_reason frame itself is split — proves B28's buffer also protects
    // the B29 signal (a split terminal frame must not be silently dropped).
    const fr = finishFrame('length');
    const cut = Math.floor(fr.length / 2);
    mockStreamFromChunks([deltaFrame('cut off here'), fr.slice(0, cut), fr.slice(cut), 'data: [DONE]\n']);

    const reasons: Array<LLMResponse['finishReason']> = [];
    const out = await collect({ ...base, onFinish: (r) => reasons.push(r) });
    expect(out).toBe('cut off here');
    expect(reasons).toContain('length');
  });
});
