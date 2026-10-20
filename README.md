# LeetSmith 🧠

**An AI learning coach for LeetCode that teaches you through a problem — without ever handing over the full solution.**

LeetSmith is a Chrome extension that opens a side panel on LeetCode problem pages and offers on-demand coaching: progressive hints, pre-submission code analysis, deep "why does this work" explanations, and saveable study notes. It is built to *teach*, not to solve — the opposite of a solve-it-for-you tool.

It runs on your own free Google Gemini API key (bring-your-own-key), so there's no cost, no account, and no backend — your key, notes, and progress stay in your browser.

### ▶️ Install from the Chrome Web Store

**[Add LeetSmith to Chrome →](https://chromewebstore.google.com/detail/leetsmith/cpamikikbpieldjmkdaamlepjjilelja)**

You'll need a free Google Gemini API key from [aistudio.google.com](https://aistudio.google.com) → **Get API key** (no billing required). Paste it into the extension's Settings and you're set.

> **Not affiliated with LeetCode.** LeetSmith is an independent project and is not
> affiliated with, endorsed by, sponsored by, or produced by LeetCode. It is a
> companion tool that works with the LeetCode website; "LeetCode" is a trademark of
> its respective owner.

---

## What it does

Every coaching action is grounded in the specific problem on your screen. Four one-tap buttons cover the high-value intents:

- **💡 Hint** — progressive hints across 3 levels (conceptual → approach → implementation), never a full solution.
- **🔬 Analyze my code** — reads your current editor code and gives feedback on approach, efficiency (with an operation-by-operation time/space breakdown of *your* code versus the optimal), and code style, all before you submit.
- **🧠 Understand solution** — explains *why* the optimal solution works: a real-world analogy, the key insight, why each part is necessary, and the complexity line by line.
- **📝 Generate report** — a study-note report of the problem you can save and review later.

**Or just ask.** Type what you want and LeetSmith routes it to the right kind of help — "break this down into steps", "what pattern is this?", "give me another example", "what's the time complexity of my code?". Anything that would reveal the answer asks you to confirm first, so a solution is never shown by phrasing alone; ambiguous or general questions get a direct, code-aware chat answer.

It also keeps **per-problem history** that persists across sessions, a **dark / light** theme, and **free-tier guardrails** you control — rate limits, a token cap, a usage meter, and a kill switch.

## How it works

A standard Chrome extension (Manifest V3) with three isolated parts:

- **Content script** reads the problem (title, difficulty, description) from the LeetCode page and your code from the Monaco editor.
- **Side panel** (React + TypeScript + Tailwind) is the UI — it calls Google Gemini directly with your key, streams the response, and renders it.
- **Background service worker** coordinates the parts and persists state to `chrome.storage.local`.

Problem data flows on a **pull-based** model: the side panel requests the current problem from the content script when it's ready, which stays reliable even when Chrome puts the service worker to sleep.

The "teach, never solve" rule is enforced in layers: prompt-level rules ask the model to coach rather than solve, and a deterministic output filter holds the line if a response drifts toward a complete answer. The three actions that discuss your *own* code (analyze, understand, report) are intentionally exempt.

See [`src/README.md`](src/README.md) for the source-tree layout.

## Privacy

- **No backend, no account, no tracking.** Everything runs client-side in your browser.
- Your Gemini API key, notes, and progress are stored locally in `chrome.storage.local`.
- The only data that leaves your device is the current problem and the code you choose to get help on, sent directly to Google's Gemini API using your own key.

Full details: [`PRIVACY.md`](PRIVACY.md).

## Build from source

Prefer to build it yourself instead of installing from the store:

### Prerequisites
- Node.js (LTS)
- A free Google Gemini API key ([aistudio.google.com](https://aistudio.google.com) → **Get API key**)

### Build & load
```bash
npm install
npm run build        # on Windows PowerShell, use: npm.cmd run build
```
Then:
1. Go to `chrome://extensions`
2. Enable **Developer mode** (top-right)
3. Click **Load unpacked** and select the `dist/` folder

> After rebuilding, reload the extension at `chrome://extensions`. If a LeetCode tab was already open before the reload, refresh it.

### Use it
1. Open any LeetCode problem (`leetcode.com/problems/...`)
2. Click the LeetSmith toolbar icon to open the side panel
3. Open ⚙️ Settings, paste your Gemini API key, and pick a model (Flash-Lite is the fast, free-tier-friendly default)
4. Tap a coaching action or ask your own question

## Tech stack

React 19 · TypeScript 5.8 · Tailwind CSS 4 · Vite 7 · Chrome Extension Manifest V3 · Google Gemini (OpenAI-compatible endpoint)

## Design philosophy

LeetSmith is a *learning* tool first. It withholds complete solutions on purpose, so the value is in building genuine understanding — not shipping green checkmarks. It's free to run, and your data stays in your browser.

---