import { test, expect } from './fixtures.js';
import JSZip from 'jszip';

const MOCK_BASE = 'http://confluence.mock';

const MOCK_CONFLUENCE_HTML = `<!DOCTYPE html><html><head></head><body>
<script>
window.AJS = {
  contextPath: () => '',
  Meta: { get: (k) => k === 'space-key' ? 'TEST' : null },
};
</script>
<h1>Mock Confluence Page</h1>
</body></html>`;

const SIMPLE_PAGES = [
  { id: '100', title: 'Home', ancestors: [] },
  { id: '101', title: 'Child Page', ancestors: [{ id: '100', title: 'Home' }] },
];

const SIMPLE_CONTENT = {
  '100': '<h1>Home</h1><p>Welcome to the home page.</p>',
  '101': '<h2>Child Page</h2><p>This is a child page.</p>',
};

function buildMockRouter(pages, content, { attachmentBodies = {} } = {}) {
  return async (route) => {
    const url = new URL(route.request().url());

    if (/^\/rest\/api\/space\//.test(url.pathname)) {
      const key = url.pathname.split('/').pop();
      await route.fulfill({ json: { key, name: 'Test Space' } });
    } else if (/^\/rest\/api\/content\/\d+$/.test(url.pathname)) {
      const pageId = url.pathname.split('/').pop();
      await route.fulfill({
        json: { body: { view: { value: content[pageId] ?? '<p>Empty.</p>' } } },
      });
    } else if (url.pathname === '/rest/api/content') {
      await route.fulfill({ json: { results: pages, _links: {} } });
    } else if (/^\/download\/(attachments|thumbnails)\//.test(url.pathname)) {
      const filename = decodeURIComponent(url.pathname.split('/').pop());
      const body = attachmentBodies[filename] ?? Buffer.from(`binary-${filename}`);
      const ext = filename.split('.').pop();
      const types = { png: 'image/png', jpg: 'image/jpeg', pdf: 'application/pdf' };
      await route.fulfill({ contentType: types[ext] ?? 'application/octet-stream', body });
    } else {
      await route.fulfill({ contentType: 'text/html', body: MOCK_CONFLUENCE_HTML });
    }
  };
}

async function triggerExportAndCapture(context, extensionId) {
  const mockPage = await context.newPage();
  await mockPage.goto(`${MOCK_BASE}/spaces/TEST/pages/100/Home`);

  // Monkey-patch chrome.downloads.download in SW to capture all zip downloads
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker');
  await sw.evaluate(() => {
    globalThis.__capturedDownloads = [];
    chrome.downloads.download = (opts) => {
      globalThis.__capturedDownloads.push(opts);
    };
  });

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await mockPage.bringToFront();

  await popup.evaluate(() => document.getElementById('action-btn').click());

  await popup.waitForFunction(
    () => document.getElementById('status').textContent.startsWith('Done!'),
    { timeout: 10000 },
  );

  // Extract captured zips
  const downloads = await sw.evaluate(() => globalThis.__capturedDownloads);
  const zips = [];
  for (const dl of downloads) {
    const base64 = dl.url.replace('data:application/zip;base64,', '');
    zips.push({ zip: await JSZip.loadAsync(Buffer.from(base64, 'base64')), filename: dl.filename });
  }

  // For backward compat: return first zip as `zip` and `filename`
  return { zip: zips[0].zip, filename: zips[0].filename, zips, popup, mockPage };
}

test.describe('Export flow — mock Confluence server', () => {
  test('completes full export and shows done message', async ({ context, extensionId }) => {
    await context.route(`${MOCK_BASE}/**`, buildMockRouter(SIMPLE_PAGES, SIMPLE_CONTENT));

    const { popup } = await triggerExportAndCapture(context, extensionId);

    await expect(popup.locator('#status')).toHaveText(`Done! ${SIMPLE_PAGES.length} pages in 1 zip`);
    await expect(popup.locator('#action-btn')).toBeEnabled({ timeout: 500 });
    await expect(popup.locator('#progress-bar-wrap')).toBeHidden({ timeout: 500 });
  });
});

test.describe('Zip content verification', () => {
  const PAGES = [
    { id: '100', title: 'Home', ancestors: [] },
    { id: '101', title: 'Child Page', ancestors: [{ id: '100', title: 'Home' }] },
    { id: '102', title: 'Grandchild', ancestors: [{ id: '100', title: 'Home' }, { id: '101', title: 'Child Page' }] },
  ];

  const CONTENT = {
    // Root page: has internal link to child + an embedded image
    '100': '<h1>Home</h1>'
      + '<p>See <a href="/spaces/TEST/pages/101/Child-Page">Child Page</a></p>'
      + '<img src="/download/attachments/100/diagram.png" alt="Diagram">',
    // Child page: has internal link to grandchild + an attached PDF
    '101': '<h2>Child</h2>'
      + '<p>Go to <a href="/pages/viewpage.action?pageId=102">Grandchild</a></p>'
      + '<p>Download <a href="/download/attachments/101/report.pdf">Report</a></p>',
    // Grandchild: has link back to root + image
    '102': '<h3>Grandchild</h3>'
      + '<p>Back to <a href="/spaces/TEST/pages/100/Home">Home</a></p>'
      + '<img src="/download/attachments/102/photo.jpg" alt="Photo">',
  };

  test('zip filename uses sanitized space name', async ({ context, extensionId }) => {
    await context.route(`${MOCK_BASE}/**`, buildMockRouter(PAGES, CONTENT));
    const { filename } = await triggerExportAndCapture(context, extensionId);
    expect(filename).toBe('Test-Space.zip');
  });

  test('zip has correct hierarchical folder structure', async ({ context, extensionId }) => {
    await context.route(`${MOCK_BASE}/**`, buildMockRouter(PAGES, CONTENT));
    const { zip } = await triggerExportAndCapture(context, extensionId);

    const paths = Object.keys(zip.files).filter(p => p.endsWith('.md'));
    expect(paths).toContain('Home.md');
    expect(paths).toContain('Home/Child-Page.md');
    expect(paths).toContain('Home/Child-Page/Grandchild.md');
  });

  test('internal links are rewritten to relative .md paths', async ({ context, extensionId }) => {
    await context.route(`${MOCK_BASE}/**`, buildMockRouter(PAGES, CONTENT));
    const { zip } = await triggerExportAndCapture(context, extensionId);

    const homeMd = await zip.file('Home.md').async('string');
    // Root → Child: relative path from root
    expect(homeMd).toContain('Home/Child-Page.md');
    expect(homeMd).not.toContain('/spaces/TEST/pages/101');

    const childMd = await zip.file('Home/Child-Page.md').async('string');
    // Child → Grandchild: relative path within same parent folder
    expect(childMd).toContain('Child-Page/Grandchild.md');
    expect(childMd).not.toContain('pageId=102');

    const grandchildMd = await zip.file('Home/Child-Page/Grandchild.md').async('string');
    // Grandchild → Root: two levels up
    expect(grandchildMd).toContain('../../Home.md');
    expect(grandchildMd).not.toContain('/spaces/TEST/pages/100');
  });

  test('images are downloaded and stored with correct zip paths', async ({ context, extensionId }) => {
    await context.route(`${MOCK_BASE}/**`, buildMockRouter(PAGES, CONTENT));
    const { zip } = await triggerExportAndCapture(context, extensionId);

    const allPaths = Object.keys(zip.files);

    // Root-level page image: no leading slash
    expect(allPaths).toContain('images/diagram.png');
    expect(allPaths).not.toEqual(expect.arrayContaining(['/images/diagram.png']));
    const imgData = await zip.file('images/diagram.png').async('string');
    expect(imgData).toBe('binary-diagram.png');

    // Grandchild image
    expect(allPaths).toContain('Home/Child-Page/images/photo.jpg');
  });

  test('image references in markdown use relative local paths', async ({ context, extensionId }) => {
    await context.route(`${MOCK_BASE}/**`, buildMockRouter(PAGES, CONTENT));
    const { zip } = await triggerExportAndCapture(context, extensionId);

    const homeMd = await zip.file('Home.md').async('string');
    expect(homeMd).toContain('./images/diagram.png');
    expect(homeMd).not.toContain('/download/attachments/100');

    const grandchildMd = await zip.file('Home/Child-Page/Grandchild.md').async('string');
    expect(grandchildMd).toContain('./images/photo.jpg');
    expect(grandchildMd).not.toContain('/download/attachments/102');
  });

  test('file attachments are downloaded and referenced correctly', async ({ context, extensionId }) => {
    await context.route(`${MOCK_BASE}/**`, buildMockRouter(PAGES, CONTENT));
    const { zip } = await triggerExportAndCapture(context, extensionId);

    const allPaths = Object.keys(zip.files);
    expect(allPaths).toContain('Home/attachments/report.pdf');

    const pdfData = await zip.file('Home/attachments/report.pdf').async('string');
    expect(pdfData).toBe('binary-report.pdf');

    const childMd = await zip.file('Home/Child-Page.md').async('string');
    expect(childMd).toContain('./attachments/report.pdf');
    expect(childMd).not.toContain('/download/attachments/101');
  });

  test('markdown contains readable content (headings, paragraphs)', async ({ context, extensionId }) => {
    await context.route(`${MOCK_BASE}/**`, buildMockRouter(PAGES, CONTENT));
    const { zip } = await triggerExportAndCapture(context, extensionId);

    const homeMd = await zip.file('Home.md').async('string');
    expect(homeMd).toMatch(/^# Home/m);

    const childMd = await zip.file('Home/Child-Page.md').async('string');
    expect(childMd).toMatch(/^## Child/m);
  });

  test('progress bar fills during export', async ({ context, extensionId }) => {
    await context.route(`${MOCK_BASE}/**`, buildMockRouter(PAGES, CONTENT));

    const mockPage = await context.newPage();
    await mockPage.goto(`${MOCK_BASE}/spaces/TEST/pages/100/Home`);

    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker');
    await sw.evaluate(() => {
      globalThis.__capturedDownload = null;
      chrome.downloads.download = (opts) => { globalThis.__capturedDownload = opts; };
    });

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await mockPage.bringToFront();

    // Install observers BEFORE triggering export to catch transient progress bar
    await popup.evaluate(() => {
      const wrap = document.getElementById('progress-bar-wrap');
      const bar = document.getElementById('progress-bar');
      globalThis.__progressSeen = { shown: false, maxWidth: 0 };
      const check = () => {
        if (!wrap.hidden) {
          globalThis.__progressSeen.shown = true;
          const w = parseInt(bar.style.width, 10);
          if (w > globalThis.__progressSeen.maxWidth) globalThis.__progressSeen.maxWidth = w;
        }
      };
      new MutationObserver(check).observe(wrap, { attributes: true });
      new MutationObserver(check).observe(bar, { attributes: true, attributeFilter: ['style'] });
    });

    await popup.evaluate(() => document.getElementById('action-btn').click());

    await popup.waitForFunction(
      () => document.getElementById('status').textContent.startsWith('Done!'),
      { timeout: 10000 },
    );

    const progress = await popup.evaluate(() => globalThis.__progressSeen);
    expect(progress.shown).toBe(true);
    expect(progress.maxWidth).toBeGreaterThan(0);
    await expect(popup.locator('#progress-bar-wrap')).toBeHidden({ timeout: 500 });
  });
});

test.describe('Chunked zip export', () => {
  const CHUNK_SIZE = 50;
  const PAGE_COUNT = CHUNK_SIZE + 3; // 53 pages → 2 zips

  function generatePages(count) {
    const pages = [];
    const content = {};
    for (let i = 0; i < count; i++) {
      const id = String(200 + i);
      pages.push({ id, title: `Page ${id}`, ancestors: [] });
      content[id] = `<p>Content of page ${id}.</p>`;
    }
    return { pages, content };
  }

  test('splits export into multiple zips when pages exceed chunk size', async ({ context, extensionId }) => {
    const { pages, content } = generatePages(PAGE_COUNT);
    await context.route(`${MOCK_BASE}/**`, buildMockRouter(pages, content));

    const { zips, popup } = await triggerExportAndCapture(context, extensionId);

    expect(zips.length).toBe(2);
    expect(zips[0].filename).toBe('Test-Space-1.zip');
    expect(zips[1].filename).toBe('Test-Space-2.zip');

    const firstZipMds = Object.keys(zips[0].zip.files).filter(p => p.endsWith('.md'));
    const secondZipMds = Object.keys(zips[1].zip.files).filter(p => p.endsWith('.md'));
    expect(firstZipMds.length).toBe(CHUNK_SIZE);
    expect(secondZipMds.length).toBe(PAGE_COUNT - CHUNK_SIZE);

    await expect(popup.locator('#status')).toHaveText(`Done! ${PAGE_COUNT} pages in 2 zips`);
  });

  test('export completes without error when popup closes mid-export', async ({ context, extensionId }) => {
    const { pages, content } = generatePages(CHUNK_SIZE);
    await context.route(`${MOCK_BASE}/**`, buildMockRouter(pages, content));

    const mockPage = await context.newPage();
    await mockPage.goto(`${MOCK_BASE}/spaces/TEST/pages/200/Page-200`);

    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker');
    await sw.evaluate(() => {
      globalThis.__capturedDownloads = [];
      globalThis.__swErrors = [];
      chrome.downloads.download = (opts) => { globalThis.__capturedDownloads.push(opts); };
      self.addEventListener('error', (e) => { globalThis.__swErrors.push(e.message); });
      self.addEventListener('unhandledrejection', (e) => { globalThis.__swErrors.push(e.reason?.message ?? String(e.reason)); });
    });

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await mockPage.bringToFront();
    await popup.evaluate(() => document.getElementById('action-btn').click());

    // Wait briefly for export to start, then close the popup (disconnects port)
    await popup.waitForFunction(
      () => document.getElementById('status').textContent.includes('pages'),
      { timeout: 5000 },
    );
    await popup.close();

    // Give the service worker time to finish the export with the disconnected port
    await sw.evaluate(() => new Promise(r => setTimeout(r, 3000)));

    const errors = await sw.evaluate(() => globalThis.__swErrors);
    const disconnectErrors = errors.filter(e => e.includes('disconnected'));
    expect(disconnectErrors).toEqual([]);

    const downloads = await sw.evaluate(() => globalThis.__capturedDownloads);
    expect(downloads.length).toBe(1);
  });

  test('produces single zip without part suffix when pages fit in one chunk', async ({ context, extensionId }) => {
    const { pages, content } = generatePages(CHUNK_SIZE);
    await context.route(`${MOCK_BASE}/**`, buildMockRouter(pages, content));

    const { zips } = await triggerExportAndCapture(context, extensionId);

    expect(zips.length).toBe(1);
    expect(zips[0].filename).toBe('Test-Space.zip');
  });
});
