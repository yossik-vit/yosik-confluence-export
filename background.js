importScripts('utils.js', 'vendor/jszip.min.js', 'vendor/turndown.js', 'vendor/turndown-plugin-gfm.js');

const PAGE_LIMIT = 50;

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'export') return;
  port.onMessage.addListener(({ action }) => {
    if (action === 'start') runExport(port);
  });
});

async function detectConfluenceContext(tabId, tabUrl) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
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

async function runExport(port) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  port.postMessage({ type: 'progress', message: 'Detecting space…' });

  const { baseUrl, spaceKey } = await detectConfluenceContext(tab.id, tab.url);
  port.postMessage({ type: 'progress', message: 'Fetching page list…' });

  const pages = await fetchAllPages(baseUrl, spaceKey, (count) => {
    port.postMessage({ type: 'progress', message: `Found ${count} pages…` });
  });

  const pageIndex = buildPageIndex(pages);
  console.log('Page index:', [...pageIndex.entries()]);
  port.postMessage({ type: 'done', message: `Found ${pages.length} pages` });
}
