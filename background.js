/* global sanitizeZipFilename, sanitizeZipPathSegment */

importScripts('utils.js', 'vendor/jszip.min.js', 'vendor/emoji-map.js');

const PAGE_LIMIT = 50;
const FETCH_CONCURRENCY = 5;
const MSG_CHUNK_BYTES = 32 * 1024 * 1024; // 32 MiB — well under Chrome's 64 MiB sendMessage limit

function safePostMessage(port, msg) {
  try {
    port.postMessage(msg);
  } catch {
    // Port disconnected (popup closed) — nothing to report to.
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'export') return;
  port.onMessage.addListener(({ action, tabId, tabUrl }) => {
    if (action === 'start') runExport(port, tabId, tabUrl);
  });
});

async function detectConfluenceContext(tabId, tabUrl) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: () => ({
      contextPath: globalThis.AJS?.contextPath?.() ?? '',
      spaceKey: globalThis.AJS?.Meta?.get?.('space-key') ?? null,
    }),
  });
  const { contextPath, spaceKey } = results[0].result;
  if (!spaceKey) throw new Error('Not a Confluence space page.');
  const { origin } = new URL(tabUrl);
  return { baseUrl: origin + contextPath, spaceKey };
}

async function fetchSpaceName(baseUrl, spaceKey) {
  const url = `${baseUrl}/rest/api/space/${spaceKey}`;
  const res = await fetch(url, { credentials: 'include' });
  if (res.status === 401) throw new Error('Session expired. Reload Confluence and retry.');
  const data = await res.json();
  return data.name;
}

async function fetchAllPages(baseUrl, spaceKey, onProgress) {
  const pages = [];
  let start = 0;
  while (true) {
    const url = `${baseUrl}/rest/api/content?spaceKey=${spaceKey}&type=page` +
      `&expand=ancestors&limit=${PAGE_LIMIT}&start=${start}`;
    const res = await fetch(url, { credentials: 'include' });
    if (res.status === 401) throw new Error('Session expired. Reload Confluence and retry.');
    const data = await res.json();
    pages.push(...data.results);
    onProgress(pages.length);
    if (!data._links?.next) break;
    start += data.results.length;
  }
  return pages;
}

async function fetchPageContent(baseUrl, pageId) {
  const url = `${baseUrl}/rest/api/content/${pageId}?expand=body.view`;
  const res = await fetch(url, { credentials: 'include' });
  if (res.status === 401) throw new Error('Session expired. Reload Confluence and retry.');
  const data = await res.json();
  return data.body?.view?.value ?? '';
}

const OFFSCREEN_RETRY_LIMIT = 10;
const OFFSCREEN_RETRY_DELAY_MS = 100;

async function htmlToMarkdown(html) {
  for (let attempt = 0; attempt < OFFSCREEN_RETRY_LIMIT; attempt++) {
    const response = await chrome.runtime.sendMessage({
      action: 'convert-html',
      html,
    });
    if (response?.markdown !== undefined) return response.markdown;
    await ensureOffscreenDocument();
    await new Promise(r => setTimeout(r, OFFSCREEN_RETRY_DELAY_MS));
  }
  throw new Error('Offscreen document did not respond to convert-html');
}

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

async function downloadAttachments(html, baseUrl, zipFolderPath, zip) {
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

  for (const [originalUrl, { localPath }] of urlsToDownload) {
    const absoluteUrl = originalUrl.startsWith('http')
      ? originalUrl
      : baseUrl + originalUrl.split('?')[0];
    const res = await fetch(absoluteUrl, { credentials: 'include' });
    if (res.ok) {
      const buffer = await res.arrayBuffer();
      zip.file(localPath, buffer, { binary: true });
    }
  }

  let rewritten = html;
  for (const [originalUrl, { subdir, filename }] of urlsToDownload) {
    const relPath = `./${subdir}/${escapeParensForMarkdown(filename)}`;
    rewritten = rewritten.split(originalUrl).join(relPath);
  }

  return rewritten;
}

async function exportAllPages(pages, pageIndex, baseUrl, zip, port, doneOffset = 0, totalPages = pages.length) {
  const total = totalPages;
  let done = doneOffset;

  for (let i = 0; i < pages.length; i += FETCH_CONCURRENCY) {
    const batch = pages.slice(i, i + FETCH_CONCURRENCY);
    await Promise.all(batch.map(async (page) => {
      let html = await fetchPageContent(baseUrl, page.id);
      const { zipPath } = pageIndex.get(page.id);
      const zipFolder = zipPath.split('/').slice(0, -1).join('/');

      html = rewriteInternalLinks(html, zipPath, pageIndex);
      html = replaceEmojis(html, EMOJI_SHORTCODE_MAP);
      html = await downloadAttachments(html, baseUrl, zipFolder, zip);

      const markdown = await htmlToMarkdown(html);
      zip.file(zipPath, markdown);
      done++;
      safePostMessage(port, { type: 'progress', current: done, total, message: page.title });
    }));
  }
}

const OFFSCREEN_READY_LIMIT = 50;
const OFFSCREEN_READY_DELAY_MS = 50;

async function ensureOffscreenDocument() {
  const existing = await chrome.offscreen.hasDocument();
  if (!existing) {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: [chrome.offscreen.Reason.BLOBS],
      justification: 'HTML-to-Markdown conversion and zip download',
    });
  }
  for (let i = 0; i < OFFSCREEN_READY_LIMIT; i++) {
    const res = await chrome.runtime.sendMessage({ action: 'ping' });
    if (res?.ready) return;
    await new Promise(r => setTimeout(r, OFFSCREEN_READY_DELAY_MS));
  }
  throw new Error('Offscreen document failed to initialize');
}

const ZIP_CHUNK_SIZE = 50;

async function triggerDownload(zip, filename) {
  const base64 = await zip.generateAsync({ type: 'base64', compression: 'DEFLATE' });
  const chunkBytes = globalThis.__msgChunkBytes ?? MSG_CHUNK_BYTES;

  if (base64.length <= chunkBytes) {
    await chrome.runtime.sendMessage({
      action: 'trigger-download',
      base64,
      filename,
    });
  } else {
    for (let i = 0; i < base64.length; i += chunkBytes) {
      await chrome.runtime.sendMessage({
        action: 'blob-chunk',
        chunk: base64.slice(i, i + chunkBytes),
      });
    }
    await chrome.runtime.sendMessage({
      action: 'trigger-download-from-chunks',
      filename,
    });
  }
}

function sanitizeSpaceName(spaceName) {
  return sanitizeZipPathSegment(spaceName, 'Confluence-Export');
}

const KEEPALIVE_INTERVAL_MS = 25000;

async function runExport(port, tabId, tabUrl) {
  const keepaliveId = setInterval(() => { chrome.runtime.getPlatformInfo(); }, KEEPALIVE_INTERVAL_MS);
  try {
  safePostMessage(port, { type: 'progress', message: 'Detecting space…' });

  const { baseUrl, spaceKey } = await detectConfluenceContext(tabId, tabUrl);
  const spaceName = await fetchSpaceName(baseUrl, spaceKey);
  safePostMessage(port, { type: 'progress', message: 'Fetching page list…' });

  const pages = await fetchAllPages(baseUrl, spaceKey, (count) => {
    safePostMessage(port, { type: 'progress', message: `Found ${count} pages…` });
  });

  const safeName = sanitizeSpaceName(spaceName);
  const pageIndex = buildPageIndex(pages, safeName);

  await ensureOffscreenDocument();
  const chunks = [];
  for (let i = 0; i < pages.length; i += ZIP_CHUNK_SIZE) {
    chunks.push(pages.slice(i, i + ZIP_CHUNK_SIZE));
  }
  const totalChunks = chunks.length;

  let globalDone = 0;
  for (let c = 0; c < totalChunks; c++) {
    const chunk = chunks[c];
    const zip = new JSZip();
    const chunkLabel = totalChunks > 1 ? ` (part ${c + 1}/${totalChunks})` : '';

    safePostMessage(port, { type: 'progress', message: `Exporting pages${chunkLabel}…`, current: globalDone, total: pages.length });
    await exportAllPages(chunk, pageIndex, baseUrl, zip, port, globalDone, pages.length);
    globalDone += chunk.length;

    const filename = totalChunks > 1
      ? `${safeName}-${c + 1}.zip`
      : `${safeName}.zip`;
    safePostMessage(port, { type: 'progress', message: `Building zip${chunkLabel}…` });
    await triggerDownload(zip, filename);
  }

  safePostMessage(port, { type: 'done', message: `Done! ${pages.length} pages in ${totalChunks} zip${totalChunks > 1 ? 's' : ''}` });
  } catch (err) {
    safePostMessage(port, { type: 'error', message: err.message });
  } finally {
    clearInterval(keepaliveId);
  }
}
