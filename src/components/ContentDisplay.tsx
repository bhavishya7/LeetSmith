import React, { useEffect, useRef } from 'react';
import type { LearningContent } from '../types';
import { isSolutionExemptAction } from '../services/solution-filter';
import ThinkingIndicator from './ThinkingIndicator';
import { thinkingLabel } from './thinking-labels';
import { splitComplexity, formatComplexityInner, maskComplexity, COMPLEXITY_SENTINEL_RE } from './complexity-parse';
import WelcomeCard from './WelcomeCard';

interface ContentDisplayProps {
  content: LearningContent[];
  isLoading: boolean;
  streamingId: string | null;
  /** Save a finished report card to persistent progress. Absent = not offered. */
  onSaveToProgress?: (item: LearningContent) => void;
  /**
   * E9: the agentic chat loop's current PROCESS step ("Reading your code",
   * "Answering") for the streaming card's thinking placeholder. Process-only
   * (never answer content), so it's safe to show live. Absent = no loop running.
   */
  agentStepLabel?: string;
}

const TYPE_META: Record<LearningContent['type'], { accent: string; icon: string }> = {
  HINT:         { accent: 'border-l-yellow-400', icon: '💡' },
  EXAMPLES:     { accent: 'border-l-blue-400',   icon: '🔢' },
  BREAKDOWN:    { accent: 'border-l-purple-400', icon: '🧩' },
  EXPLANATION:  { accent: 'border-l-green-400',  icon: '📚' },
  FEEDBACK:     { accent: 'border-l-teal-400',   icon: '✅' },
  CHAT_MESSAGE: { accent: 'border-l-neutral-400',icon: '💬' },
};

const ACTION_LABELS: Record<string, string> = {
  GET_HINT: 'Hint', GENERATE_EXAMPLES: 'New Examples', BREAK_DOWN_PROBLEM: 'Problem Breakdown',
  EXPLAIN_CONCEPT: 'Concept Explanation', CHECK_APPROACH: 'Approach Review',
  TIME_COMPLEXITY_HINT: 'Complexity Hint', PATTERN_RECOGNITION: 'Pattern Recognition',
  UNDERSTAND_SOLUTION: 'Understand Solution', GENERATE_REPORT: 'Study Report',
};

/**
 * Defensive cleanup for math notation the model sometimes emits despite the
 * prompt asking for plain text. Converts inline LaTeX ($...$ and \(...\)) into
 * backtick code so it renders cleanly instead of showing raw dollar signs.
 */
function stripLatex(text: string): string {
  return text
    .replace(/\\\((.+?)\\\)/g, (_, inner) => `\`${inner.trim()}\``)
    .replace(/\$([^$\n]+?)\$/g, (_, inner) => `\`${inner.trim()}\``);
}

/**
 * Renders Big-O / complexity notation with proper formatting:
 * - O(N²) instead of O(n^2)
 * - Styled as a visually distinct inline badge
 * Handles: O(1), O(N), O(N²), O(N³), O(N log N), O(2^N), O(N!), etc.
 */
function renderComplexity(text: string, keyBase: number): React.ReactNode[] {
  // splitComplexity handles BALANCED (possibly nested) parens, so a complexity
  // like "O(log(M) + log(N))" is captured whole instead of the old regex
  // stopping at the first ")" and leaking the tail as prose (B7).
  const segments = splitComplexity(text);
  const parts: React.ReactNode[] = segments.map((seg, i) => {
    if (seg.kind === 'text') return <React.Fragment key={`t-${keyBase}-${i}`}>{seg.value}</React.Fragment>;
    // Normalize the inner text: uppercase standalone variables (n→N, m→M)
    // WITHOUT corrupting words like min/log (B13 sibling fix lives in
    // formatComplexityInner), then superscript ^2/N2 forms.
    const formatted = formatComplexityInner(seg.inner);
    const superscripted = formatSuperscripts(formatted);
    return (
      <span key={`complexity-${keyBase}-${seg.at}`}
        className="inline-flex items-baseline px-1 rounded bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-300 font-mono text-[12px] font-semibold whitespace-nowrap">
        O({superscripted})
      </span>
    );
  });
  return parts.length > 0 ? parts : [text];
}

/** Converts ^2, ^3 etc. AND bare trailing digits like N2 into superscript elements. */
function formatSuperscripts(text: string): React.ReactNode {
  // First normalize: if the model wrote "N2" or "n2" (no caret), insert one.
  // Match a letter followed directly by a digit (e.g. N2 → N^2, N3 → N^3).
  const normalized = text.replace(/([A-Za-z])(\d+)/g, '$1^$2');
  const parts = normalized.split(/(\^\d+)/g);
  return parts.map((part, i) => {
    if (part.startsWith('^')) {
      return <sup key={i} className="text-[9px]">{part.slice(1)}</sup>;
    }
    return part;
  });
}

/**
 * Renders a plain-text run that may contain masked complexity sentinels. Splits
 * on the sentinel, rendering the complexity tokens as badges and the rest as
 * text. This is the "restore" half of the B13 mask/restore: by the time we get
 * here, markdown emphasis has already been applied to the MASKED text, so the
 * `*` inside an `O(N*M)` was never exposed to the emphasis split.
 */
function renderMaskedText(part: string, tokens: string[], keyBase: number): React.ReactNode {
  if (!part.includes('\u0000CX')) return <React.Fragment key={keyBase}>{part}</React.Fragment>;
  const pieces = part.split(COMPLEXITY_SENTINEL_RE);
  // split with one capture group yields: [text, idx, text, idx, text, ...]
  return pieces.map((piece, i) => {
    if (i % 2 === 1) {
      const token = tokens[Number(piece)] ?? '';
      return <React.Fragment key={`${keyBase}-cx-${i}`}>{renderComplexity(token, keyBase * 100 + i)}</React.Fragment>;
    }
    return <React.Fragment key={`${keyBase}-tx-${i}`}>{piece}</React.Fragment>;
  });
}

function renderInline(raw: string): React.ReactNode {
  const text = stripLatex(raw);
  // B13: the markdown emphasis split used to also treat a SINGLE `*…*` as
  // italic. That ate the asterisks in complexity/multiplication expressions —
  // both inside a badge (`O(N*M)`) and in plain prose (`…total characters, N *
  // M. The next loop…`), where two stray `*` on a line got paired into a bogus
  // italic run. The model is instructed to write plain text (no markdown
  // italic) and nothing in our prompts asks for single-`*` emphasis, so we only
  // honor `**bold**` and `` `code` `` and leave every other `*` literal.
  //
  // We still MASK each O(...) group to a sentinel before the split so the badge
  // renderer receives a clean token (and a `**` that happens to border a
  // complexity can't swallow it); the sentinel carries no `*`.
  const { masked, tokens } = maskComplexity(text);
  return masked.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) return <strong key={i} className="font-semibold text-neutral-900 dark:text-white">{renderMaskedText(part.slice(2, -2), tokens, i)}</strong>;
    if (part.startsWith('`') && part.endsWith('`')) return <code key={i} className="bg-neutral-200 dark:bg-neutral-700 text-pink-600 dark:text-pink-300 px-1 rounded font-mono text-[12px] break-words">{part.slice(1, -1)}</code>;
    // Plain-text run: restore any masked complexity tokens as badges. Bare `*`
    // in prose (e.g. "N * M") is left exactly as written.
    return <React.Fragment key={i}>{renderMaskedText(part, tokens, i)}</React.Fragment>;
  });
}

/**
 * Picks a heading color from its leading emoji / keyword so each section has a
 * clear visual identity (like LeetCode's colored section headers). Falls back
 * to a neutral-but-distinct indigo.
 */
function headingColor(text: string): string {
  const t = text.toLowerCase();
  if (t.includes('approach') || t.includes('🧭')) return 'text-blue-600 dark:text-blue-400';
  if (t.includes('efficiency') || t.includes('complexity') || t.includes('⚡') || t.includes('📊') || t.includes('⏱')) return 'text-amber-600 dark:text-amber-400';
  if (t.includes('code style') || t.includes('🎨')) return 'text-purple-600 dark:text-purple-400';
  if (t.includes('analogy') || t.includes('🌍') || t.includes('why it works') || t.includes('⚙')) return 'text-emerald-600 dark:text-emerald-400';
  if (t.includes('insight') || t.includes('🔑') || t.includes('hint') || t.includes('💡') || t.includes('think')) return 'text-yellow-600 dark:text-yellow-400';
  if (t.includes('pattern') || t.includes('🔍') || t.includes('breakdown') || t.includes('step') || t.includes('🧩')) return 'text-pink-600 dark:text-pink-400';
  if (t.includes('example') || t.includes('🔢')) return 'text-cyan-600 dark:text-cyan-400';
  return 'text-indigo-600 dark:text-indigo-400';
}

function renderContent(text: string): React.ReactNode {
  if (!text) return null;
  const lines = text.split('\n');
  const elements: React.ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('```')) {
      const codeLines: string[] = []; i++;
      while (i < lines.length && !lines[i].startsWith('```')) { codeLines.push(lines[i]); i++; }
      elements.push(<pre key={i} className="bg-neutral-950 text-neutral-100 border border-neutral-700 rounded p-2 text-[12px] overflow-x-auto my-1.5 font-mono leading-relaxed">{codeLines.join('\n')}</pre>);
    } else if (line.startsWith('## ')) { elements.push(<h2 key={i} className={`font-bold text-[15px] mt-3 mb-1 ${headingColor(line)}`}>{line.slice(3)}</h2>); }
    else if (line.startsWith('### ')) { elements.push(<h3 key={i} className={`font-semibold text-[13px] mt-2 mb-0.5 ${headingColor(line)}`}>{line.slice(4)}</h3>); }
    else if (line.startsWith('- ') || line.startsWith('* ')) { elements.push(<li key={i} className="ml-4 text-[13px] text-neutral-800 dark:text-neutral-100 list-disc leading-relaxed">{renderInline(line.slice(2))}</li>); }
    else if (/^\d+\.\s/.test(line)) { elements.push(<li key={i} className="ml-4 text-[13px] text-neutral-800 dark:text-neutral-100 list-decimal leading-relaxed">{renderInline(line.replace(/^\d+\.\s/, ''))}</li>); }
    else if (line.trim() === '') { elements.push(<div key={i} className="h-1.5" />); }
    else { elements.push(<p key={i} className="text-[13px] text-neutral-800 dark:text-neutral-100 leading-relaxed">{renderInline(line)}</p>); }
    i++;
  }
  return <>{elements}</>;
}

const UserBubble: React.FC<{ text: string }> = ({ text }) => (
  <div className="flex justify-end mb-2.5 leetsage-enter">
    <div className="leetsage-sage-fill max-w-[85%] rounded-2xl rounded-br-sm px-3.5 py-2 text-[13px] break-words shadow-sm">{text}</div>
  </div>
);

const ContentCard: React.FC<{
  item: LearningContent;
  isStreaming: boolean;
  /** B1: this card is a non-exempt action mid-stream — show the gated
   *  "thinking" placeholder instead of streamed tokens (content is withheld
   *  until the filter has run). */
  isGated: boolean;
  onSaveToProgress?: (item: LearningContent) => void;
  isSaved?: boolean;
  /** E9: live agent step label for THIS card's thinking placeholder (if any). */
  stepLabel?: string;
}> = ({ item, isStreaming, isGated, onSaveToProgress, isSaved, stepLabel }) => {
  const [expanded, setExpanded] = React.useState(true);
  const [copied, setCopied] = React.useState(false);
  const meta = TYPE_META[item.type];
  const label = ACTION_LABELS[item.actionType] ?? item.actionType;
  const time = new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation(); // don't toggle the card's expand/collapse
    try {
      await navigator.clipboard.writeText(item.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can fail if the document isn't focused; fail silently.
    }
  };

  // A free-form chat REPLY (user bubbles are intercepted earlier in the render
  // loop, so a CHAT_MESSAGE reaching here is the assistant's answer). Chat
  // answers aren't a labeled coaching "action", so they drop the action-card
  // chrome — no "Concept Explanation" header, icon, or expand/collapse toggle;
  // just the answer + a copy button, reading like a conversation reply. The old
  // behavior hard-coded the EXPLAIN_CONCEPT label onto every chat answer (it
  // reused that action type as a container), which mislabeled e.g. a "what can
  // you do?" reply as "Concept Explanation". Routed ACTIONS keep their real
  // labeled headers. Presentation only — the action type is unchanged.
  const isChatReply = item.type === 'CHAT_MESSAGE';

  if (isChatReply) {
    return (
      <div className="leetsage-enter border border-neutral-200 dark:border-neutral-700 border-l-2 border-l-[var(--sage-mid)] bg-white dark:bg-neutral-800 rounded-lg mb-2.5 shadow-sm px-3 py-2.5 min-w-0 break-words overflow-x-hidden">
        {isGated
          ? <ThinkingIndicator label={thinkingLabel(item.actionType, true)} stepLabel={stepLabel} />
          : item.content
            ? renderContent(item.content)
            : <div className="h-4 bg-neutral-200 dark:bg-neutral-700 rounded animate-pulse" />}
        {isStreaming && !isGated && item.content && <span className="leetsage-caret" aria-hidden="true" />}
        {item.content && !isStreaming && (
          <div className="flex justify-end items-center gap-2 mt-1.5">
            <button
              onClick={handleCopy}
              title={copied ? 'Copied!' : 'Copy to clipboard'}
              aria-label="Copy to clipboard"
              className={`inline-flex items-center justify-center w-6 h-6 rounded text-xs transition-colors cursor-pointer
                ${copied
                  ? 'text-green-600 dark:text-green-400'
                  : 'text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-700'}`}
            >
              {copied ? '✓' : '⧉'}
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className={`leetsage-enter border border-neutral-200 dark:border-neutral-700 border-l-2 ${meta.accent} bg-white dark:bg-neutral-800 rounded-lg overflow-hidden mb-2.5 shadow-sm`}>
      <button onClick={() => setExpanded(v => !v)} className="w-full flex items-center justify-between px-3 py-2.5 text-left hover:bg-neutral-50 dark:hover:bg-neutral-700/50 transition-colors" aria-expanded={expanded}>
        <div className="flex items-center gap-1.5">
          <span className="text-sm">{meta.icon}</span>
          <span className="text-[13px] font-semibold text-neutral-800 dark:text-neutral-100">{label}</span>
          {item.metadata?.hintLevel && <span className="text-[10px] bg-yellow-400/20 text-yellow-600 dark:text-yellow-400 px-1.5 rounded-full">Level {item.metadata.hintLevel}</span>}
          {/* Live "generating…" tag only for actions that stream visibly (exempt
              actions). Gated non-exempt cards show their own thinking label. */}
          {isStreaming && !isGated && <span className="text-[10px] text-neutral-400 animate-pulse">generating…</span>}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-neutral-400">{time}</span>
          <span className="text-neutral-400 text-xs">{expanded ? '▲' : '▼'}</span>
        </div>
      </button>
      {/* Animated expand/collapse: a grid-rows 1fr↔0fr transition (see
          index.css .leetsage-collapsible) instead of an instant conditional
          render. The inner wrapper collapses to zero height smoothly. */}
      <div className="leetsage-collapsible" data-collapsed={!expanded} aria-hidden={!expanded}>
        <div className="leetsage-collapsible-inner">
        <div className="px-3 pb-2.5 min-w-0 break-words overflow-x-hidden">
          {isGated
            // B1: non-exempt action mid-stream — withhold tokens, show the
            // animated action-aware "thinking" placeholder until the filter runs.
            ? <ThinkingIndicator label={thinkingLabel(item.actionType, item.type === 'CHAT_MESSAGE')} stepLabel={stepLabel} />
            : item.content
              ? renderContent(item.content)
              : <div className="h-4 bg-neutral-200 dark:bg-neutral-700 rounded animate-pulse" />}
          {/* Streaming blinking cursor (E2 §3.1): shows at the live end of
              content that is ALREADY cleared for display — i.e. exempt actions
              streaming live (not gated). The B1 gate still withholds non-exempt
              tokens behind the ThinkingIndicator, so the caret never paints on
              gated-but-unfiltered content. The fix vs. the old version: a real
              steady-blink caret (.leetsage-caret) tied to the sage accent,
              rendered inline right after the streamed prose. */}
          {isStreaming && !isGated && item.content && <span className="leetsage-caret" aria-hidden="true" />}
          {item.content && !isStreaming && (
            <div className="flex justify-end items-center gap-2 mt-1.5">
              {/* Save-to-progress: only offered on a finished Study Report card. */}
              {item.actionType === 'GENERATE_REPORT' && onSaveToProgress && (
                <button
                  onClick={(e) => { e.stopPropagation(); if (!isSaved) onSaveToProgress(item); }}
                  disabled={isSaved}
                  title={isSaved ? 'Saved to My Progress' : 'Save this report to My Progress'}
                  className={`leetsage-pressable inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium border transition-colors
                    ${isSaved
                      ? 'text-green-600 dark:text-green-400 border-green-500/40 cursor-default'
                      : 'text-teal-700 dark:text-teal-300 border-[var(--sage-ring)] hover:bg-[var(--sage-tint)] cursor-pointer'}`}
                >
                  {isSaved ? '✓ Saved' : '💾 Save to My Progress'}
                </button>
              )}
              <button
                onClick={handleCopy}
                title={copied ? 'Copied!' : 'Copy to clipboard'}
                aria-label="Copy to clipboard"
                className={`inline-flex items-center justify-center w-6 h-6 rounded text-xs transition-colors cursor-pointer
                  ${copied
                    ? 'text-green-600 dark:text-green-400'
                    : 'text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-700'}`}
              >
                {copied ? '✓' : '⧉'}
              </button>
            </div>
          )}
        </div>
        </div>
      </div>
    </div>
  );
};

const ContentDisplay: React.FC<ContentDisplayProps> = ({ content, isLoading, streamingId, onSaveToProgress, agentStepLabel }) => {
  const bottomRef = useRef<HTMLDivElement>(null);
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [content.length, streamingId]);

  if (content.length === 0 && !isLoading) {
    // E4 first-run welcome / empty state (chat-polish §5). The same WelcomeCard
    // is re-openable from the header "?" button, so the two can't drift.
    return (
      <div className="flex-1 flex items-center justify-center px-6 leetsage-enter">
        <WelcomeCard />
      </div>
    );
  }

  return (
    <div className="flex-1 min-w-0 overflow-x-hidden overflow-y-auto px-3 py-3">
      {content.map(item => {
        if (item.type === 'CHAT_MESSAGE' && item.actionType === 'CHECK_APPROACH' && item.metadata?.isUserQuery) {
          return <UserBubble key={item.id} text={item.content} />;
        }
        const isStreaming = item.id === streamingId;
        // B1 pre-display gate: while a NON-EXEMPT action streams, its tokens are
        // withheld (accumulated in App, not pushed to `content`), so this card
        // shows the "thinking" placeholder instead of partial, unfiltered text.
        // Exempt actions stream live, so they are never gated.
        const isGated = isStreaming && !isSolutionExemptAction(item.actionType);
        return (
          <ContentCard
            key={item.id}
            item={item}
            isStreaming={isStreaming}
            isGated={isGated}
            onSaveToProgress={onSaveToProgress}
            isSaved={item.metadata?.savedToProgress ?? false}
            stepLabel={isStreaming ? agentStepLabel : undefined}
          />
        );
      })}
      <div ref={bottomRef} />
    </div>
  );
};

export default ContentDisplay;
