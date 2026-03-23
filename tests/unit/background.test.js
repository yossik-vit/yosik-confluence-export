import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const backgroundSrc = readFileSync(join(__dir, '../../background.js'), 'utf8');

const EXPOSE_INTERNALS = `
this.htmlToMarkdown = htmlToMarkdown;
this.ensureOffscreenDocument = ensureOffscreenDocument;
this.runExport = runExport;
this.safePostMessage = safePostMessage;
`;

function buildMockContext(overrides = {}) {
  const sendMessageResponses = [];
  const sendMessageCalls = [];
  const hasDocumentResults = [];
  const createDocumentCalls = [];
  const onConnectListeners = [];
  const intervals = [];
  let intervalIdCounter = 0;
  const clearedIntervals = [];

  const ctx = {
    importScripts() {},
    setTimeout(fn) { fn(); return 0; },
    setInterval(fn, delay) {
      const id = ++intervalIdCounter;
      intervals.push({ id, fn, delay });
      return id;
    },
    clearInterval(id) { clearedIntervals.push(id); },
    Promise,
    Map,
    Set,
    URL,
    console,
    fetch: overrides.fetch ?? (async () => ({ ok: true, status: 200, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) })),
    globalThis: {},

    // Chrome API mocks
    chrome: {
      runtime: {
        onConnect: {
          addListener(fn) { onConnectListeners.push(fn); },
        },
        async sendMessage(msg) {
          sendMessageCalls.push(msg);
          if (sendMessageResponses.length > 0) {
            return sendMessageResponses.shift();
          }
          return undefined;
        },
        getPlatformInfo() { return Promise.resolve({ os: 'mac' }); },
      },
      offscreen: {
        Reason: { BLOBS: 'BLOBS' },
        async hasDocument() {
          if (hasDocumentResults.length > 0) return hasDocumentResults.shift();
          return true;
        },
        async createDocument(opts) {
          createDocumentCalls.push(opts);
        },
      },
      scripting: {
        async executeScript() {
          return [{ result: { contextPath: '', spaceKey: 'TEST' } }];
        },
      },
    },

    // Globals normally loaded via importScripts
    JSZip: class {
      file() {}
      async generateAsync() { return 'base64data'; }
    },
    EMOJI_SHORTCODE_MAP: {},
    sanitizeZipFilename: (name) => name,
    sanitizeZipPathSegment: (name, fallback) => name || fallback,
    pageToFilename: (title) => `${title}.md`,
    pageToFolderName: (title) => title,
    buildPageIndex: (pages, root) => {
      const index = new Map();
      for (const p of pages) {
        index.set(p.id, { zipPath: `${root}/${p.title}.md` });
      }
      return index;
    },
    computeRelativePath: () => './',
    rewriteInternalLinks: (html) => html,
    escapeParensForMarkdown: (s) => s,
    replaceEmojis: (html) => html,

    // Test inspection helpers
    _sendMessageResponses: sendMessageResponses,
    _sendMessageCalls: sendMessageCalls,
    _hasDocumentResults: hasDocumentResults,
    _createDocumentCalls: createDocumentCalls,
    _onConnectListeners: onConnectListeners,
    _intervals: intervals,
    _clearedIntervals: clearedIntervals,
  };

  return ctx;
}

describe('htmlToMarkdown offscreen recovery', () => {
  let ctx;

  beforeEach(() => {
    ctx = buildMockContext();
  });

  it('returns markdown on first successful response', async () => {
    ctx._sendMessageResponses.push(
      { markdown: '# Hello' },  // convert-html succeeds immediately
    );
    runInNewContext(backgroundSrc + EXPOSE_INTERNALS, ctx);

    const result = await ctx.htmlToMarkdown('<h1>Hello</h1>');
    assert.equal(result, '# Hello');
  });

  it('recreates offscreen doc when response is undefined and retries', async () => {
    // 1. convert-html returns undefined (offscreen closed by Chrome)
    // 2. ensureOffscreenDocument: hasDocument → false → creates doc → ping succeeds
    // 3. retry convert-html → succeeds
    ctx._sendMessageResponses.push(
      undefined,          // first convert-html — offscreen closed
      { ready: true },    // ensureOffscreenDocument ping after recreation
      { markdown: 'ok' }, // second convert-html — success
    );
    ctx._hasDocumentResults.push(
      false, // ensureOffscreenDocument check — doc was closed by Chrome
    );
    runInNewContext(backgroundSrc + EXPOSE_INTERNALS, ctx);

    const result = await ctx.htmlToMarkdown('<p>ok</p>');
    assert.equal(result, 'ok');

    // Verify ensureOffscreenDocument was called to recreate
    assert.ok(
      ctx._createDocumentCalls.length >= 1,
      'expected offscreen document to be recreated',
    );
  });

  it('throws after all retries exhausted when offscreen never responds', async () => {
    const RETRY_LIMIT = 10;
    for (let i = 0; i < RETRY_LIMIT; i++) {
      ctx._sendMessageResponses.push(undefined);       // convert-html fails
      ctx._sendMessageResponses.push({ ready: true });  // ensureOffscreenDocument ping
      ctx._hasDocumentResults.push(true);                // doc exists but not responding
    }
    runInNewContext(backgroundSrc + EXPOSE_INTERNALS, ctx);

    await assert.rejects(
      () => ctx.htmlToMarkdown('<p>fail</p>'),
      { message: 'Offscreen document did not respond to convert-html' },
    );
  });
});

describe('service worker keepalive during export', () => {
  it('starts keepalive interval during export and clears it on success', async () => {
    const ctx = buildMockContext({
      fetch: async (url) => {
        if (url.includes('/rest/api/space/')) {
          return { ok: true, status: 200, json: async () => ({ name: 'Test Space' }) };
        }
        if (url.includes('/rest/api/content?')) {
          return { ok: true, status: 200, json: async () => ({ results: [{ id: '1', title: 'Home', ancestors: [] }], _links: {} }) };
        }
        if (url.includes('/rest/api/content/')) {
          return { ok: true, status: 200, json: async () => ({ body: { view: { value: '<p>Hello</p>' } } }) };
        }
        return { ok: true, status: 200, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) };
      },
    });
    // Responses for ensureOffscreenDocument ping + convert-html + trigger-download
    ctx._sendMessageResponses.push(
      { ready: true },
      { markdown: '# Home' },
      { ok: true },
    );
    runInNewContext(backgroundSrc + EXPOSE_INTERNALS, ctx);

    const messages = [];
    const port = {
      postMessage(msg) { messages.push(msg); },
    };

    await ctx.runExport(port, 1, 'https://confluence.example.com/wiki/page');

    assert.ok(
      ctx._intervals.length >= 1,
      'expected at least one keepalive interval to be started',
    );
    const keepaliveInterval = ctx._intervals[0];
    assert.ok(
      ctx._clearedIntervals.includes(keepaliveInterval.id),
      'expected keepalive interval to be cleared after export',
    );
  });

  it('clears keepalive interval even when export fails', async () => {
    const ctx = buildMockContext({
      fetch: async () => {
        throw new Error('Network error');
      },
    });
    runInNewContext(backgroundSrc + EXPOSE_INTERNALS, ctx);

    const messages = [];
    const port = {
      postMessage(msg) { messages.push(msg); },
    };

    await ctx.runExport(port, 1, 'https://confluence.example.com/wiki/page');

    // Export should have failed but keepalive should still be cleaned up
    const errorMsg = messages.find(m => m.type === 'error');
    assert.ok(errorMsg, 'expected an error message');

    if (ctx._intervals.length > 0) {
      const keepaliveInterval = ctx._intervals[0];
      assert.ok(
        ctx._clearedIntervals.includes(keepaliveInterval.id),
        'expected keepalive interval to be cleared after error',
      );
    }
  });
});
