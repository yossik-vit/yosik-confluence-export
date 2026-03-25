# Pipeline Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix empty-content export bug by moving Turndown back to offscreen DOM, with clean I/O-parallel / CPU-sequential pipeline.

**Architecture:** Background fetches pages in parallel (sliding window, 5 concurrent). Fetched HTML queues for sequential Turndown conversion in offscreen main thread via port. Attachments download in parallel per page. No Web Workers.

**Tech Stack:** Chrome MV3, Turndown + GFM, JSZip, vanilla JS.

---

### Task 1: Delete Web Worker infrastructure

**Files:**
- Delete: `turndown-worker.js`
- Modify: `offscreen.html` — restore Turndown script tags
- Modify: `offscreen.js` — replace worker pool with direct Turndown + port handler
- Modify: `eslint.config.js` — remove turndown-worker config

- [ ] **Step 1: Rewrite offscreen.html to load Turndown directly**

```html
<!DOCTYPE html>
<body>
<script src="vendor/turndown.js"></script>
<script src="vendor/turndown-plugin-gfm.js"></script>
<script src="confluence-turndown-rules.js"></script>
<script src="offscreen.js"></script>
</body>
```

- [ ] **Step 2: Rewrite offscreen.js — Turndown in main thread, port-based sequential conversion**

Replace entire file. Key design: port listener processes conversions one at a time (Turndown is sync CPU-bound). `sendMessage` for ping/downloads only.

```js
/* global TurndownService, turndownPluginGfm, addConfluenceTurndownRules */

const turndown = (() => {
  const td = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
  });
  td.use(turndownPluginGfm.gfm);
  addConfluenceTurndownRules(td);
  return td;
})();

function fixMarkdownTables(md) {
  const lines = md.split('\n');
  const result = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isTableRow = line.trimStart().startsWith('|') && line.trimEnd().endsWith('|') && line.includes('|', 1);
    if (line.trim() === '|') continue;
    if (isTableRow && i > 0) {
      const prevLine = result[result.length - 1] ?? '';
      const prevIsTable = prevLine.trimStart().startsWith('|') && prevLine.trimEnd().endsWith('|');
      if (!prevIsTable && prevLine.trim() !== '') result.push('');
    }
    result.push(line);
  }
  return result.join('\n');
}

// Port-based: background sends {id, html}, we reply {id, markdown}
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'turndown') return;
  port.onMessage.addListener((msg) => {
    const { id, html } = msg;
    try {
      let markdown = turndown.turndown(html);
      markdown = fixMarkdownTables(markdown);
      port.postMessage({ id, markdown });
    } catch (err) {
      port.postMessage({ id, markdown: '', error: err.message });
    }
  });
});

// sendMessage: ping + download triggers only
const BLOB_REVOKE_DELAY_MS = 1000;
function base64ToBlob(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: 'application/zip' });
}
function triggerAnchorDownload(base64, filename) {
  const blob = base64ToBlob(base64);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), BLOB_REVOKE_DELAY_MS);
}
let pendingChunks = [];
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === 'ping') { sendResponse({ ready: true }); return true; }
  if (msg.action === 'blob-chunk') { pendingChunks.push(msg.chunk); sendResponse({ ok: true }); return true; }
  if (msg.action === 'trigger-download-from-chunks') {
    const b = pendingChunks.join(''); pendingChunks = [];
    triggerAnchorDownload(b, msg.filename); sendResponse({ ok: true }); return true;
  }
  if (msg.action === 'trigger-download') {
    triggerAnchorDownload(msg.base64, msg.filename); sendResponse({ ok: true }); return true;
  }
});
```

- [ ] **Step 3: Delete turndown-worker.js**

```bash
rm turndown-worker.js
```

- [ ] **Step 4: Remove turndown-worker eslint config from eslint.config.js**

Delete the `files: ['turndown-worker.js']` block. Restore offscreen globals to include Turndown.

- [ ] **Step 5: Update offscreen test mock**

In `tests/unit/offscreen.test.js`: remove `Worker`, `Map`, `Promise`, `clearTimeout` from mock context (no longer needed). Keep `addConfluenceTurndownRules` stub.

- [ ] **Step 6: Run tests**

```bash
npm test
```

Expected: all pass (offscreen tests may need mock `onConnect` adjustment — `port.onMessage.addListener` pattern in mock).

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "refactor: remove Web Workers, restore Turndown to offscreen main thread"
```

---

### Task 2: Simplify background.js — clean pipeline

**Files:**
- Modify: `background.js` — rewrite export pipeline

- [ ] **Step 1: Replace constants and remove dead code**

Remove: `MAX_CONCURRENCY`, `INITIAL_CONCURRENCY`, `MIN_CONCURRENCY`, `RETRY_CONCURRENCY`, `PAGE_TIMEOUT_MS`, `PAGE_FETCH_TIMEOUT_MS`, `withTimeout`, `runPageQueue`, `activeThreads`, `updateThread`, adaptive concurrency logic.

Replace with:

```js
const FETCH_CONCURRENCY = 5;
const FETCH_TIMEOUT_MS = 30000;   // 30s per API call
const ATTACH_TIMEOUT_MS = 10000;  // 10s per attachment
```

- [ ] **Step 2: Simplify htmlToMarkdown — port-based, no retry loop**

```js
let turndownPort = null;
const turndownCallbacks = new Map();
let turndownIdCounter = 0;

function getTurndownPort() {
  if (turndownPort) return turndownPort;
  turndownPort = chrome.runtime.connect({ name: 'turndown' });
  turndownPort.onMessage.addListener((msg) => {
    const cb = turndownCallbacks.get(msg.id);
    if (cb) { turndownCallbacks.delete(msg.id); cb(msg.markdown ?? ''); }
  });
  turndownPort.onDisconnect.addListener(() => { turndownPort = null; });
  return turndownPort;
}

async function htmlToMarkdown(html) {
  await ensureOffscreenDocument();
  const port = getTurndownPort();
  const id = ++turndownIdCounter;
  return new Promise((resolve) => {
    turndownCallbacks.set(id, resolve);
    port.postMessage({ id, html });
  });
}
```

- [ ] **Step 3: Rewrite processPage — simple, no try/catch swallowing**

```js
async function processPage(page, pageIndex, baseUrl, zip, isCloud, exportOpts) {
  const meta = await fetchPageContent(baseUrl, page.id, isCloud);
  let html = meta.html;
  const { zipPath } = pageIndex.get(page.id);
  const zipFolder = zipPath.split('/').slice(0, -1).join('/');

  html = rewriteInternalLinks(html, zipPath, pageIndex);
  html = replaceEmojis(html, EMOJI_SHORTCODE_MAP);

  if (!exportOpts.skipAttachments) {
    html = await downloadAttachments(html, baseUrl, zipFolder, zip, exportOpts.maxAttachmentBytes);
  }

  const markdown = await htmlToMarkdown(html);
  const frontmatter = generateFrontmatter(page, meta);
  zip.file(zipPath, frontmatter + markdown);
  return { ok: true, title: page.title };
}
```

- [ ] **Step 4: Rewrite exportPages — sliding window with simple error handling**

```js
async function exportPages(pages, pageIndex, baseUrl, zip, port, isCloud, exportOpts, doneOffset = 0, totalPages = pages.length) {
  const total = totalPages;
  let done = doneOffset;
  let failed = 0;
  let nextIndex = 0;
  const active = new Set();

  function startNext() {
    while (active.size < FETCH_CONCURRENCY && nextIndex < pages.length) {
      if (exportAbort?.signal?.aborted) return;
      const page = pages[nextIndex++];
      const task = processPage(page, pageIndex, baseUrl, zip, isCloud, exportOpts)
        .then(() => {
          done++;
          safePostMessage(port, { type: 'progress', current: done, total });
        })
        .catch(() => {
          done++;
          failed++;
          safePostMessage(port, { type: 'progress', current: done, total });
        })
        .finally(() => { active.delete(task); });
      active.add(task);
    }
  }

  startNext();
  while (active.size > 0) {
    if (exportAbort?.signal?.aborted) throw new Error('Export cancelled.');
    await Promise.race(active);
    startNext();
  }
  return failed;
}
```

- [ ] **Step 5: Simplify downloadAttachments — remove skipAttachments param (handled by caller)**

Change signature: `async function downloadAttachments(html, baseUrl, zipFolderPath, zip, maxBytes)`

Remove the `if (skipAttachments) return html;` guard (caller checks).

- [ ] **Step 6: Simplify run functions — remove activeThreads, adaptive concurrency, retry passes**

Each `run*` function: remove `updateThread` calls, remove two-pass retry, remove adaptive concurrency. Single pass, failed pages counted and reported.

- [ ] **Step 7: Run tests, fix any failures**

```bash
npm test
```

Fix background test mocks as needed (connect mock, simplified expectations).

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "refactor: clean pipeline — parallel fetch, sequential convert, no workers"
```

---

### Task 3: Manual verification

**Files:** none (testing only)

- [ ] **Step 1: Load extension in Chrome**

Go to `chrome://extensions/` → reload the extension.

- [ ] **Step 2: Export a single page**

Open a Confluence page → click extension → select one page → Export.
Verify: ZIP contains .md file with frontmatter AND content (not empty).

- [ ] **Step 3: Export 10 pages**

Select a small folder (~10 pages) → Export.
Verify: all .md files have content. Check tables render in Obsidian.

- [ ] **Step 4: Full space export**

Select all → Export. Monitor progress. Verify speed is stable (~2-5 pages/sec).
After completion, spot-check 5 random files for content.

- [ ] **Step 5: Commit final state**

```bash
git add -A && git commit -m "test: verify pipeline refactor on Confluence Server"
```

---

### Task 4: Push

- [ ] **Step 1: Push to remote**

```bash
git push
```
