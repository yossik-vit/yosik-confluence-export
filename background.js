/* global sanitizeZipFilename, sanitizeZipPathSegment, buildPageIndex, rewriteInternalLinks, replaceEmojis, escapeParensForMarkdown, pageToFilename, EMOJI_SHORTCODE_MAP */

importScripts('utils.js', 'vendor/jszip.min.js', 'vendor/emoji-map.js');

// ── Debug log ───────────────────────────────────────────────────────────────

const LOG_MAX = 2000;
const logBuffer = [];

function log(level, msg, data) {
  const entry = {
    t: new Date().toISOString().slice(11, 23), // HH:mm:ss.SSS
    l: level,
    m: msg,
    ...(data !== undefined ? { d: data } : {}),
  };
  logBuffer.push(entry);
  if (logBuffer.length > LOG_MAX) logBuffer.shift();
  if (level === 'error') {
    console.error(`[yosik] ${msg}`, data ?? '');
  } else {
    console.log(`[yosik] ${msg}`, data ?? '');
  }
}

const PAGE_LIMIT = 50;
const ZIP_CHUNK_SIZE = 200;
const FETCH_CONCURRENCY = 5;
const FETCH_TIMEOUT_MS = 30000;
const ATTACH_TIMEOUT_MS = 10000;
const MSG_CHUNK_BYTES = 32 * 1024 * 1024;

function fetchWithTimeout(url, opts, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // Link to export-level abort so cancel interrupts in-flight requests
  const onExportAbort = () => controller.abort();
  if (exportAbort?.signal && !exportAbort.signal.aborted) {
    exportAbort.signal.addEventListener('abort', onExportAbort);
  }
  return fetch(url, { ...opts, signal: controller.signal })
    .finally(() => {
      clearTimeout(timer);
      exportAbort?.signal?.removeEventListener('abort', onExportAbort);
    });
}

// ── Export state (survives popup close/reopen) ──────────────────────────────

let exportState = null;
let exportAbort = null;
let exportRunning = false;
const activePorts = new Set();

function setExportState(state) {
  exportState = state;
}

function safePostMessage(port, msg) {
  if (msg.type === 'progress' || msg.type === 'done' || msg.type === 'error') {
    setExportState(msg);
  }
  if (msg.type === 'done' || msg.type === 'error') {
    setTimeout(() => { exportState = null; }, 30000);
  }
  try { port.postMessage(msg); } catch { /* popup closed */ }
  for (const p of activePorts) {
    if (p === port) continue;
    try { p.postMessage(msg); } catch { activePorts.delete(p); }
  }
}

// ── Attachment skip tracking ────────────────────────────────────────────────

let skippedAttachments = { count: 0, totalBytes: 0 };

function resetSkippedAttachments() {
  skippedAttachments = { count: 0, totalBytes: 0 };
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function doneMessage(total, skippedPages) {
  const exported = total - (skippedPages || 0);
  let msg = `Done! ${exported} pages exported.`;
  if (skippedPages > 0) msg += ` ${skippedPages} skipped (timeout).`;
  msg += skippedSummary();
  return msg;
}

function skippedSummary() {
  if (skippedAttachments.count === 0) return '';
  return ` (skipped ${skippedAttachments.count} attachments, ${formatBytes(skippedAttachments.totalBytes)})`;
}

// ── Message routing ─────────────────────────────────────────────────────────

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'export') return;
  activePorts.add(port);
  port.onDisconnect.addListener(() => { activePorts.delete(port); });

  port.onMessage.addListener((msg) => {
    if (msg.action === 'get-status') {
      if (exportState) {
        try { port.postMessage(exportState); } catch { /* ignore */ }
      }
      return;
    }
    if (msg.action === 'get-logs') {
      try { port.postMessage({ type: 'logs', logs: logBuffer.slice(-500) }); } catch { /* ignore */ }
      return;
    }
    if (msg.action === 'cancel') {
      if (exportAbort) {
        exportAbort.abort();
        exportAbort = null;
      }
      setExportState(null);
      safePostMessage(port, { type: 'error', message: 'Export cancelled.' });
      return;
    }
    const opts = {
      skipAttachments: msg.skipAttachments ?? true,
      maxAttachmentBytes: msg.maxAttachmentBytes ?? 0,
      preserveOrder: msg.preserveOrder ?? false,
      incremental: msg.incremental ?? false,
    };

    if (msg.action === 'start') runExport(port, msg.tabId, msg.tabUrl, opts, msg.incremental);
    if (msg.action === 'export-page') runExportPage(port, msg.tabId, msg.tabUrl, opts);
    if (msg.action === 'export-selected') runExportSelected(port, msg.tabId, msg.tabUrl, msg.pageIds, opts);
    if (msg.action === 'fetch-tree') {
      if (exportRunning) {
        // Don't load tree while export is running — would compete for Confluence API
        try { port.postMessage({ type: 'tree-blocked' }); } catch { /* ignore */ }
      } else {
        fetchTreeForPopup(port, msg.tabId, msg.tabUrl);
      }
    }
  });
});

// ── Confluence detection & API ──────────────────────────────────────────────

async function detectConfluenceContext(tabId, tabUrl) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: () => ({
      contextPath: globalThis.AJS?.contextPath?.() ?? '',
      spaceKey: globalThis.AJS?.Meta?.get?.('space-key') ?? null,
      pageId: globalThis.AJS?.Meta?.get?.('page-id') ?? null,
      pageTitle: globalThis.AJS?.Meta?.get?.('page-title') ?? null,
    }),
  });
  const { contextPath, spaceKey, pageId, pageTitle } = results[0].result;
  if (!spaceKey) throw new Error('Not a Confluence space page.');
  const { origin } = new URL(tabUrl);
  const baseUrl = origin + contextPath;

  // Detect Cloud vs Server
  const isCloud = await detectCloudApi(baseUrl);

  return { baseUrl, spaceKey, pageId, pageTitle, isCloud };
}

async function detectCloudApi(baseUrl) {
  try {
    const res = await fetchWithTimeout(`${baseUrl}/wiki/api/v2/spaces?limit=1`, { credentials: 'include' }, 5000);
    return res.ok;
  } catch (err) {
    log('info', 'cloud:detect failed (assuming Server)', { error: err.message });
    return false;
  }
}

async function fetchSpaceName(baseUrl, spaceKey, isCloud) {
  if (isCloud) {
    // Cloud v2: need to get space by key
    const url = `${baseUrl}/wiki/api/v2/spaces?keys=${spaceKey}&limit=1`;
    const res = await fetch(url, { credentials: 'include' });
    if (res.status === 401) throw new Error('Session expired. Reload Confluence and retry.');
    const data = await res.json();
    return data.results?.[0]?.name ?? spaceKey;
  }
  const url = `${baseUrl}/rest/api/space/${spaceKey}`;
  const res = await fetch(url, { credentials: 'include' });
  if (res.status === 401) throw new Error('Session expired. Reload Confluence and retry.');
  const data = await res.json();
  return data.name;
}

async function fetchAllPages(baseUrl, spaceKey, isCloud, onProgress) {
  if (isCloud) return fetchAllPagesCloud(baseUrl, spaceKey, onProgress);
  return fetchAllPagesServer(baseUrl, spaceKey, onProgress);
}

async function fetchAllPagesServer(baseUrl, spaceKey, onProgress) {
  const MAX_PAGES = 10000;
  const pages = [];
  let start = 0;
  while (true) {
    const url = `${baseUrl}/rest/api/content?spaceKey=${spaceKey}&type=page` +
      `&expand=ancestors,version&limit=${PAGE_LIMIT}&start=${start}`;
    const res = await fetch(url, { credentials: 'include' });
    if (res.status === 401) throw new Error('Session expired. Reload Confluence and retry.');
    const data = await res.json();
    pages.push(...data.results);
    onProgress(pages.length);
    if (!data._links?.next) break;
    if (pages.length >= MAX_PAGES) break;
    start += data.results.length;
  }
  return pages;
}

async function fetchAllPagesCloud(baseUrl, spaceKey, onProgress) {
  // Cloud v2: first get space ID
  const spaceRes = await fetch(`${baseUrl}/wiki/api/v2/spaces?keys=${spaceKey}&limit=1`, { credentials: 'include' });
  if (spaceRes.status === 401) throw new Error('Session expired. Reload Confluence and retry.');
  const spaceData = await spaceRes.json();
  const spaceId = spaceData.results?.[0]?.id;
  if (!spaceId) throw new Error(`Space "${spaceKey}" not found.`);

  const MAX_PAGES = 10000;
  const pages = [];
  let cursor = null;
  while (true) {
    let url = `${baseUrl}/wiki/api/v2/spaces/${spaceId}/pages?limit=50&sort=title`;
    if (cursor) url += `&cursor=${cursor}`;
    const res = await fetch(url, { credentials: 'include' });
    if (res.status === 401) throw new Error('Session expired. Reload Confluence and retry.');
    const data = await res.json();
    // Normalize Cloud pages to match Server format
    for (const p of data.results) {
      pages.push({
        id: p.id,
        title: p.title,
        ancestors: p.parentId ? [{ id: p.parentId, title: '' }] : [],
        _cloudParentId: p.parentId,
      });
    }
    onProgress(pages.length);
    cursor = data._links?.next ? new URL(data._links.next, baseUrl).searchParams.get('cursor') : null;
    if (!cursor) break;
    if (pages.length >= MAX_PAGES) break;
  }

  // Build proper ancestors for Cloud pages
  const pageMap = new Map(pages.map(p => [p.id, p]));
  for (const page of pages) {
    const ancestors = [];
    let cur = page._cloudParentId;
    while (cur && pageMap.has(cur)) {
      const parent = pageMap.get(cur);
      ancestors.unshift({ id: parent.id, title: parent.title });
      cur = parent._cloudParentId;
    }
    page.ancestors = ancestors;
    delete page._cloudParentId;
  }

  return pages;
}

async function fetchPageContent(baseUrl, pageId, isCloud) {
  if (isCloud) {
    const url = `${baseUrl}/wiki/api/v2/pages/${pageId}?body-format=storage`;
    const res = await fetchWithTimeout(url, { credentials: 'include' }, FETCH_TIMEOUT_MS);
    if (res.status === 401) throw new Error('Session expired. Reload Confluence and retry.');
    const data = await res.json();
    return {
      html: data.body?.storage?.value ?? '',
      version: data.version?.number ?? null,
      lastModified: data.version?.createdAt ?? null,
      author: data.version?.authorId ?? null,
      labels: [],
    };
  }
  const url = `${baseUrl}/rest/api/content/${pageId}?expand=body.export_view,version,metadata.labels`;
  const res = await fetchWithTimeout(url, { credentials: 'include' }, FETCH_TIMEOUT_MS);
  if (res.status === 401) throw new Error('Session expired. Reload Confluence and retry.');
  const data = await res.json();
  return {
    html: data.body?.export_view?.value ?? data.body?.view?.value ?? '',
    version: data.version?.number ?? null,
    lastModified: data.version?.when ?? null,
    author: data.version?.by?.displayName ?? null,
    labels: (data.metadata?.labels?.results ?? []).map(l => l.name),
  };
}

// ── Obsidian YAML frontmatter ───────────────────────────────────────────────

function generateFrontmatter(page, meta) {
  const lines = ['---'];
  lines.push(`title: "${(page.title || 'Untitled').replace(/"/g, '\\"')}"`);
  if (meta.lastModified) {
    lines.push(`date: ${meta.lastModified.split('T')[0]}`);
  }
  lines.push(`confluence_id: "${page.id}"`);
  if (meta.author) {
    lines.push(`author: "${meta.author.replace(/"/g, '\\"')}"`);
  }
  if (meta.labels && meta.labels.length > 0) {
    lines.push(`tags: [${meta.labels.map(l => `"${l}"`).join(', ')}]`);
  }
  if (page.ancestors && page.ancestors.length > 0) {
    const parent = page.ancestors[page.ancestors.length - 1];
    lines.push(`parent: "[[${parent.title.replace(/"/g, '\\"')}]]"`);
  }
  lines.push('---');
  return lines.join('\n') + '\n\n';
}

// ── MOC (Map of Content) for Obsidian ───────────────────────────────────────

function generateMOC(tree, spaceName) {
  const lines = ['---', `title: "${spaceName} — Table of Contents"`, 'tags: ["MOC"]', '---', ''];
  lines.push(`# ${spaceName}\n`);

  function renderNode(node, depth) {
    const indent = '  '.repeat(depth);
    const link = `[[${node.title}]]`;
    lines.push(`${indent}- ${link}`);
    if (node.children) {
      for (const child of node.children) {
        renderNode(child, depth + 1);
      }
    }
  }

  for (const node of tree) {
    renderNode(node, 0);
  }

  return lines.join('\n') + '\n';
}

// ── Page tree for popup ─────────────────────────────────────────────────────

function buildTreeFromPages(pages) {
  const map = new Map();
  const roots = [];

  for (const page of pages) {
    map.set(page.id, {
      id: page.id,
      title: page.title,
      parentId: page.ancestors?.length > 0
        ? page.ancestors[page.ancestors.length - 1].id
        : null,
      children: [],
    });
  }

  for (const node of map.values()) {
    if (node.parentId && map.has(node.parentId)) {
      map.get(node.parentId).children.push(node);
    } else {
      roots.push(node);
    }
  }

  function sortTree(nodes) {
    nodes.sort((a, b) => a.title.localeCompare(b.title));
    for (const n of nodes) sortTree(n.children);
  }
  sortTree(roots);

  return roots;
}

function serializeTree(nodes) {
  return nodes.map(n => ({
    id: n.id,
    title: n.title,
    children: serializeTree(n.children),
  }));
}

async function fetchTreeForPopup(port, tabId, tabUrl) {
  try {
    const { baseUrl, spaceKey, pageId, isCloud } = await detectConfluenceContext(tabId, tabUrl);
    const spaceName = await fetchSpaceName(baseUrl, spaceKey, isCloud);

    safePostMessage(port, { type: 'tree-loading', message: 'Loading pages...' });

    const pages = await fetchAllPages(baseUrl, spaceKey, isCloud, (count) => {
      safePostMessage(port, { type: 'tree-loading', message: `Found ${count} pages...` });
    });

    const tree = buildTreeFromPages(pages);

    safePostMessage(port, {
      type: 'tree-data',
      tree: serializeTree(tree),
      spaceName,
      spaceKey,
      currentPageId: pageId,
      totalPages: pages.length,
    });
  } catch (err) {
    safePostMessage(port, { type: 'error', message: err.message });
  }
}

// ── Offscreen document + port-based parallel conversion ─────────────────────

let turndownPort = null;
const turndownCallbacks = new Map(); // id → resolve
let turndownIdCounter = 0;

function getTurndownPort() {
  if (turndownPort) return turndownPort;
  turndownPort = chrome.runtime.connect({ name: 'turndown' });
  turndownPort.onMessage.addListener((msg) => {
    const cb = turndownCallbacks.get(msg.id);
    if (cb) {
      turndownCallbacks.delete(msg.id);
      cb(msg);
    }
  });
  turndownPort.onDisconnect.addListener(() => {
    turndownPort = null;
    // Reject all pending conversions so callers don't hang
    for (const [, cb] of turndownCallbacks) {
      cb({ markdown: '', error: 'port disconnected' });
    }
    turndownCallbacks.clear();
  });
  return turndownPort;
}

async function htmlToMarkdown(html) {
  await ensureOffscreenDocument();
  const port = getTurndownPort();
  const id = ++turndownIdCounter;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      turndownCallbacks.delete(id);
      reject(new Error('Turndown conversion timeout (30s)'));
    }, 30000);
    turndownCallbacks.set(id, (msg) => {
      clearTimeout(timer);
      if (msg.error) {
        reject(new Error(msg.error));
      } else {
        resolve(msg.markdown ?? '');
      }
    });
    port.postMessage({ id, html });
  });
}

const OFFSCREEN_READY_LIMIT = 50;
const OFFSCREEN_READY_DELAY_MS = 50;

async function ensureOffscreenDocument() {
  const existing = await chrome.offscreen.hasDocument();
  if (existing && turndownPort) return; // already ready, skip ping
  if (!existing) {
    turndownPort = null; // reset port on new document
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: [chrome.offscreen.Reason.BLOBS],
      justification: 'HTML-to-Markdown conversion and zip download',
    });
  }
  // Only ping if we just created the document or port is missing
  for (let i = 0; i < OFFSCREEN_READY_LIMIT; i++) {
    const res = await chrome.runtime.sendMessage({ action: 'ping' });
    if (res?.ready) return;
    await new Promise(r => setTimeout(r, OFFSCREEN_READY_DELAY_MS));
  }
  throw new Error('Offscreen document failed to initialize');
}

// ── Concurrency limiter ──────────────────────────────────────────────────────

async function limitConcurrency(items, fn, limit) {
  let i = 0;
  const active = new Set();
  function next() {
    while (active.size < limit && i < items.length) {
      const item = items[i++];
      const p = fn(item).finally(() => { active.delete(p); });
      active.add(p);
    }
  }
  next();
  while (active.size > 0) {
    await Promise.race(active);
    next();
  }
}

// ── HTML pre-cleaning (strip Confluence bloat before Turndown) ──────────────

function cleanHtmlForTurndown(html) {
  return html
    .replace(/\s+style="[^"]*"/gi, '')
    .replace(/\s+data-[a-z-]+="[^"]*"/gi, '')
    .replace(/<span>([^<]*)<\/span>/gi, '$1')
    .replace(/src="data:image\/[^"]+"/gi, 'src=""')
    .replace(/\n{3,}/g, '\n\n');
}

// ── Attachments ─────────────────────────────────────────────────────────────

const ATTACHMENT_SRC_RE = /\/download\/(attachments|thumbnails)\/\d+\/([^?"]+)/;

function reserveUniqueZipPath(localPath, pathsSeen) {
  if (!pathsSeen.has(localPath)) {
    pathsSeen.add(localPath);
    return localPath;
  }
  const dotIndex = localPath.lastIndexOf('.');
  const hasExtension = dotIndex > localPath.lastIndexOf('/');
  const basename = hasExtension ? localPath.slice(0, dotIndex) : localPath;
  const extension = hasExtension ? localPath.slice(dotIndex) : '';
  let suffix = 2;
  let candidate = `${basename}-${suffix}${extension}`;
  while (pathsSeen.has(candidate)) {
    suffix++;
    candidate = `${basename}-${suffix}${extension}`;
  }
  pathsSeen.add(candidate);
  return candidate;
}

async function downloadAttachments(html, baseUrl, zipFolderPath, zip, maxBytes) {
  const limit = maxBytes || 0;
  const urlsToDownload = new Map();
  const localPathsSeen = new Set();

  const srcRe = /(src|href)="([^"]*\/download\/(attachments|thumbnails)\/[^"]+)"/gi;
  let m;
  while ((m = srcRe.exec(html)) !== null) {
    const attr = m[1];
    const fullUrl = m[2];
    const match = fullUrl.match(ATTACHMENT_SRC_RE);
    if (!match) continue;
    const filename = sanitizeZipFilename(decodeURIComponent(match[2]));
    const subdir = attr.toLowerCase() === 'src' ? 'images' : 'attachments';
    const localPath = reserveUniqueZipPath(
      zipFolderPath ? `${zipFolderPath}/${subdir}/${filename}` : `${subdir}/${filename}`,
      localPathsSeen,
    );
    urlsToDownload.set(fullUrl, { localPath, subdir, filename });
  }

  // Download attachments with limited concurrency
  const ATTACH_CONCURRENCY = 4;
  const entries = Array.from(urlsToDownload.entries());
  await limitConcurrency(entries, async ([originalUrl, { localPath }]) => {
    const absoluteUrl = originalUrl.startsWith('http')
      ? originalUrl
      : baseUrl + originalUrl.split('?')[0];
    try {
      const res = await fetchWithTimeout(absoluteUrl, { credentials: 'include' }, ATTACH_TIMEOUT_MS);
      if (!res.ok) return;
      const contentLength = parseInt(res.headers.get('content-length') || '0', 10);
      if (limit > 0 && contentLength > limit) {
        skippedAttachments.count++;
        skippedAttachments.totalBytes += contentLength;
        return;
      }
      const buffer = await res.arrayBuffer();
      if (limit > 0 && buffer.byteLength > limit) {
        skippedAttachments.count++;
        skippedAttachments.totalBytes += buffer.byteLength;
        return;
      }
      zip.file(localPath, buffer, { binary: true });
    } catch (err) {
      log('warn', 'attachment:failed', { url: absoluteUrl, error: err.message });
    }
  }, ATTACH_CONCURRENCY);

  let rewritten = html;
  for (const [originalUrl, { subdir, filename }] of urlsToDownload) {
    const relPath = `./${subdir}/${escapeParensForMarkdown(filename)}`;
    rewritten = rewritten.split(originalUrl).join(relPath);
  }
  return rewritten;
}

// ── Export pages to ZIP ─────────────────────────────────────────────────────

async function processPage(page, pageIndex, baseUrl, zip, isCloud, exportOpts) {
  const t0 = Date.now();
  log('info', `page:start "${page.title}"`, { id: page.id });

  const meta = await fetchPageContent(baseUrl, page.id, isCloud);
  const htmlLen = (meta.html || '').length;

  let html = meta.html;
  html = cleanHtmlForTurndown(html);
  log('info', `page:fetched "${page.title}"`, { htmlLen, cleanLen: html.length, ms: Date.now() - t0 });

  const { zipPath } = pageIndex.get(page.id);
  const zipFolder = zipPath.split('/').slice(0, -1).join('/');

  html = rewriteInternalLinks(html, zipPath, pageIndex);
  html = replaceEmojis(html, EMOJI_SHORTCODE_MAP);

  if (!exportOpts.skipAttachments) {
    const ta = Date.now();
    html = await downloadAttachments(html, baseUrl, zipFolder, zip, exportOpts.maxAttachmentBytes);
    log('info', `page:attachments "${page.title}"`, { ms: Date.now() - ta });
  }

  const tc = Date.now();
  const markdown = await htmlToMarkdown(html);
  log('info', `page:converted "${page.title}"`, { mdLen: markdown.length, ms: Date.now() - tc });

  if (markdown.length === 0) {
    log('error', `page:EMPTY markdown! "${page.title}"`, { htmlLen, zipPath });
  }

  const frontmatter = generateFrontmatter(page, meta);
  zip.file(zipPath, frontmatter + markdown);
  log('info', `page:done "${page.title}"`, { totalMs: Date.now() - t0, zipPath });
}

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
        .catch((err) => {
          done++;
          failed++;
          log('error', `page:FAILED "${page.title}"`, { error: err.message, id: page.id });
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

// ── ZIP download ────────────────────────────────────────────────────────────

async function triggerDownload(zip, filename) {
  const base64 = await zip.generateAsync({ type: 'base64', compression: 'DEFLATE' });
  const chunkBytes = globalThis.__msgChunkBytes ?? MSG_CHUNK_BYTES;

  if (base64.length <= chunkBytes) {
    await chrome.runtime.sendMessage({ action: 'trigger-download', base64, filename });
  } else {
    for (let i = 0; i < base64.length; i += chunkBytes) {
      await chrome.runtime.sendMessage({
        action: 'blob-chunk',
        chunk: base64.slice(i, i + chunkBytes),
      });
    }
    await chrome.runtime.sendMessage({ action: 'trigger-download-from-chunks', filename });
  }
}

function sanitizeSpaceName(spaceName) {
  return sanitizeZipPathSegment(spaceName, 'Confluence-Export');
}

// ── Incremental export ──────────────────────────────────────────────────────

async function getLastExportDate(spaceKey) {
  try {
    const data = await chrome.storage.local.get([`lastExport_${spaceKey}`]);
    return data[`lastExport_${spaceKey}`] ?? null;
  } catch (err) {
    log('warn', 'storage:read failed', { error: err.message });
    return null;
  }
}

async function saveLastExportDate(spaceKey) {
  try {
    await chrome.storage.local.set({ [`lastExport_${spaceKey}`]: new Date().toISOString() });
  } catch (err) {
    log('warn', 'storage:write failed', { error: err.message });
  }
}

// ── Chunked export helper ───────────────────────────────────────────────────

async function exportChunked(pages, allPages, pageIndex, baseUrl, spaceName, safeName, zipBaseName, port, isCloud, opts) {
  const chunks = [];
  for (let i = 0; i < pages.length; i += ZIP_CHUNK_SIZE) {
    chunks.push(pages.slice(i, i + ZIP_CHUNK_SIZE));
  }
  const totalChunks = chunks.length;
  let globalDone = 0;
  let totalSkipped = 0;

  for (let c = 0; c < totalChunks; c++) {
    if (exportAbort?.signal?.aborted) throw new Error('Export cancelled.');
    const chunk = chunks[c];
    const zip = new JSZip();

    // Add MOC only in first chunk
    if (c === 0) {
      const tree = buildTreeFromPages(allPages);
      zip.file(`${safeName}/_index.md`, generateMOC(tree, spaceName));
    }

    const chunkLabel = totalChunks > 1 ? ` (part ${c + 1}/${totalChunks})` : '';
    safePostMessage(port, { type: 'progress', message: `Exporting pages${chunkLabel}...`, current: globalDone, total: pages.length });

    const skipped = await exportPages(chunk, pageIndex, baseUrl, zip, port, isCloud, opts, globalDone, pages.length);
    globalDone += chunk.length;
    totalSkipped += skipped;

    const filename = totalChunks > 1
      ? `${zipBaseName.replace('.zip', '')}-${c + 1}.zip`
      : zipBaseName;
    safePostMessage(port, { type: 'progress', message: `Building zip${chunkLabel}...` });
    await triggerDownload(zip, filename);
  }

  return totalSkipped;
}

// ── Export: Full space ──────────────────────────────────────────────────────

const KEEPALIVE_INTERVAL_MS = 25000;

// Chrome alarms keepalive — prevents service worker termination even without popup
async function startKeepalive() {
  const id = setInterval(() => { chrome.runtime.getPlatformInfo(); }, KEEPALIVE_INTERVAL_MS);
  try { await chrome.alarms.create('keepalive', { periodInMinutes: 0.4 }); } catch { /* alarms may not be available */ }
  return id;
}

async function stopKeepalive(intervalId) {
  clearInterval(intervalId);
  try { await chrome.alarms.clear('keepalive'); } catch { /* ignore */ }
}

// Respond to alarm to keep service worker alive
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepalive') {
    chrome.runtime.getPlatformInfo();
  }
});

async function runExport(port, tabId, tabUrl, opts, incremental) {
  exportAbort = new AbortController();
  exportRunning = true;
  const keepaliveId = await startKeepalive();
  resetSkippedAttachments();
  log('info', 'export:start (full space)', { opts, incremental });
  try {
    safePostMessage(port, { type: 'progress', message: 'Detecting space...' });
    const { baseUrl, spaceKey, isCloud } = await detectConfluenceContext(tabId, tabUrl);
    const spaceName = await fetchSpaceName(baseUrl, spaceKey, isCloud);
    safePostMessage(port, { type: 'progress', message: 'Fetching page list...' });

    let pages = await fetchAllPages(baseUrl, spaceKey, isCloud, (count) => {
      safePostMessage(port, { type: 'progress', message: `Found ${count} pages...` });
    });

    // Incremental: filter pages modified since last export
    let incrementalLabel = '';
    if (incremental) {
      const lastDate = await getLastExportDate(spaceKey);
      if (lastDate) {
        safePostMessage(port, { type: 'progress', message: `Filtering since ${lastDate.split('T')[0]}...` });
        const filteredPages = [];
        for (const page of pages) {
          const modified = page.version?.when ?? page.version?.createdAt;
          if (modified && new Date(modified) > new Date(lastDate)) {
            filteredPages.push(page);
          }
        }
        incrementalLabel = ` (${filteredPages.length} changed since ${lastDate.split('T')[0]})`;
        // Keep all pages for index building, but only export filtered
        const allPages = pages;
        pages = filteredPages;
        if (pages.length === 0) {
          await saveLastExportDate(spaceKey);
          safePostMessage(port, { type: 'done', message: `No pages changed since ${lastDate.split('T')[0]}.` });
          return;
        }
        // Build index with all pages for correct paths
        const safeName = sanitizeSpaceName(spaceName);
        const pageIndex = buildPageIndex(allPages, safeName, opts.preserveOrder);

        await ensureOffscreenDocument();

        const skipped = await exportChunked(pages, allPages, pageIndex, baseUrl, spaceName, safeName, `${safeName}-incremental.zip`, port, isCloud, opts);
        await saveLastExportDate(spaceKey);
        safePostMessage(port, { type: 'done', message: doneMessage(pages.length, skipped) + incrementalLabel });
        return;
      }
    }

    const safeName = sanitizeSpaceName(spaceName);
    const pageIndex = buildPageIndex(pages, safeName, opts.preserveOrder);

    await ensureOffscreenDocument();

    const skipped = await exportChunked(pages, pages, pageIndex, baseUrl, spaceName, safeName, `${safeName}.zip`, port, isCloud, opts);
    await saveLastExportDate(spaceKey);

    safePostMessage(port, { type: 'done', message: doneMessage(pages.length, skipped) });
  } catch (err) {
    safePostMessage(port, { type: 'error', message: err.message });
  } finally {
    exportRunning = false;
    await stopKeepalive(keepaliveId);
  }
}

// ── Export: Single page ─────────────────────────────────────────────────────

async function runExportPage(port, tabId, tabUrl, opts) {
  exportAbort = new AbortController();
  exportRunning = true;
  const keepaliveId = await startKeepalive();
  resetSkippedAttachments();
  try {
    safePostMessage(port, { type: 'progress', message: 'Detecting page...' });
    const { baseUrl, pageId, pageTitle, isCloud } = await detectConfluenceContext(tabId, tabUrl);
    if (!pageId) throw new Error('Cannot detect current page ID.');

    await ensureOffscreenDocument();
    safePostMessage(port, { type: 'progress', message: 'Exporting page...', current: 0, total: 1 });

    const meta = await fetchPageContent(baseUrl, pageId, isCloud);
    let html = meta.html;
    html = cleanHtmlForTurndown(html);
    const zip = new JSZip();
    const title = pageTitle || 'page';
    const filename = pageToFilename(title);
    const pageObj = { id: pageId, title, ancestors: [] };
    const pageIndex = new Map();
    pageIndex.set(pageId, { title, zipPath: filename });

    html = rewriteInternalLinks(html, filename, pageIndex);
    html = replaceEmojis(html, EMOJI_SHORTCODE_MAP);
    if (!opts.skipAttachments) {
      html = await downloadAttachments(html, baseUrl, '', zip, opts.maxAttachmentBytes);
    }

    const markdown = await htmlToMarkdown(html);
    const frontmatter = generateFrontmatter(pageObj, meta);
    zip.file(filename, frontmatter + markdown);

    safePostMessage(port, { type: 'progress', current: 1, total: 1, message: title });

    const safeName = sanitizeZipPathSegment(pageTitle || 'page');
    await triggerDownload(zip, `${safeName}.zip`);
    safePostMessage(port, { type: 'done', message: `Page exported!${skippedSummary()}` });
  } catch (err) {
    safePostMessage(port, { type: 'error', message: err.message });
  } finally {
    exportRunning = false;
    await stopKeepalive(keepaliveId);
  }
}

// ── Export: Selected pages ──────────────────────────────────────────────────

async function runExportSelected(port, tabId, tabUrl, pageIds, opts) {
  exportAbort = new AbortController();
  exportRunning = true;
  const keepaliveId = await startKeepalive();
  resetSkippedAttachments();
  log('info', 'export:start (selected)', { pageCount: pageIds?.length, opts });
  try {
    if (!pageIds || pageIds.length === 0) throw new Error('No pages selected.');

    safePostMessage(port, { type: 'progress', message: 'Detecting space...' });
    const { baseUrl, spaceKey, isCloud } = await detectConfluenceContext(tabId, tabUrl);
    const spaceName = await fetchSpaceName(baseUrl, spaceKey, isCloud);
    safePostMessage(port, { type: 'progress', message: 'Fetching page list...' });

    const allPages = await fetchAllPages(baseUrl, spaceKey, isCloud, (count) => {
      safePostMessage(port, { type: 'progress', message: `Indexing ${count} pages...` });
    });

    const selectedSet = new Set(pageIds.map(String));
    let selectedPages = allPages.filter(p => selectedSet.has(String(p.id)));

    if (selectedPages.length === 0) throw new Error('None of the selected pages were found.');

    // Incremental: filter to only pages changed since last export
    let incrementalLabel = '';
    if (opts.incremental) {
      const lastDate = await getLastExportDate(spaceKey);
      if (lastDate) {
        safePostMessage(port, { type: 'progress', message: `Filtering since ${lastDate.split('T')[0]}...` });
        const filtered = [];
        for (const page of selectedPages) {
          const modified = page.version?.when ?? page.version?.createdAt;
          if (modified && new Date(modified) > new Date(lastDate)) {
            filtered.push(page);
          }
        }
        incrementalLabel = ` (${filtered.length} changed)`;
        selectedPages = filtered;
        if (selectedPages.length === 0) {
          await saveLastExportDate(spaceKey);
          safePostMessage(port, { type: 'done', message: `No pages changed since ${lastDate.split('T')[0]}.` });
          return;
        }
      }
    }

    const safeName = sanitizeSpaceName(spaceName);
    const pageIndex = buildPageIndex(allPages, safeName, opts.preserveOrder);

    await ensureOffscreenDocument();

    const zipName = selectedPages.length === allPages.length ? `${safeName}.zip` : `${safeName}-selected.zip`;
    const skipped = await exportChunked(selectedPages, allPages, pageIndex, baseUrl, spaceName, safeName, zipName, port, isCloud, opts);
    await saveLastExportDate(spaceKey);
    safePostMessage(port, { type: 'done', message: doneMessage(selectedPages.length, skipped) + incrementalLabel });
  } catch (err) {
    safePostMessage(port, { type: 'error', message: err.message });
  } finally {
    exportRunning = false;
    await stopKeepalive(keepaliveId);
  }
}
