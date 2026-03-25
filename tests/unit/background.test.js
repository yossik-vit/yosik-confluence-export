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
    AbortController,
    fetch: overrides.fetch ?? (async () => ({ ok: true, status: 200, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0), headers: { get: () => '0' } })),
    globalThis: {},

    // Chrome API mocks
    chrome: {
      runtime: {
        onConnect: {
          addListener(fn) { onConnectListeners.push(fn); },
        },
        connect(opts) {
          // Mock port for turndown: echoes back html as markdown
          const portListeners = [];
          return {
            name: opts?.name ?? 'unknown',
            postMessage(msg) {
              // Simulate async response
              setTimeout(() => {
                for (const fn of portListeners) {
                  fn({ id: msg.id, markdown: msg.html ?? '' });
                }
              }, 0);
            },
            onMessage: { addListener(fn) { portListeners.push(fn); } },
            onDisconnect: { addListener() {} },
          };
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
      alarms: {
        async create() {},
        async clear() {},
        onAlarm: { addListener() {} },
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
      storage: {
        local: {
          async get() { return {}; },
          async set() {},
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

describe('htmlToMarkdown port-based conversion', () => {
  let ctx;

  beforeEach(() => {
    ctx = buildMockContext();
  });

  it('returns markdown via port on first successful response', async () => {
    ctx._sendMessageResponses.push({ ready: true }); // ping
    runInNewContext(backgroundSrc + EXPOSE_INTERNALS, ctx);

    // Mock port echoes html as markdown — verifying round trip works
    const result = await ctx.htmlToMarkdown('<h1>Hello</h1>');
    assert.equal(result, '<h1>Hello</h1>');
  });

  it('recreates offscreen doc when not present', async () => {
    ctx._hasDocumentResults.push(false); // doc missing
    ctx._sendMessageResponses.push({ ready: true }); // ping after creation
    runInNewContext(backgroundSrc + EXPOSE_INTERNALS, ctx);

    const result = await ctx.htmlToMarkdown('<p>ok</p>');
    assert.equal(result, '<p>ok</p>');

    assert.ok(
      ctx._createDocumentCalls.length >= 1,
      'expected offscreen document to be created',
    );
  });

  it('uses port-based communication not sendMessage for conversion', async () => {
    ctx._sendMessageResponses.push({ ready: true }); // ping only
    runInNewContext(backgroundSrc + EXPOSE_INTERNALS, ctx);

    await ctx.htmlToMarkdown('<p>test</p>');

    // Verify no convert-html was sent via sendMessage (port used instead)
    const convertCalls = ctx._sendMessageCalls.filter(m => m.action === 'convert-html');
    assert.equal(convertCalls.length, 0, 'should not use sendMessage for conversion');
  });
});

describe('service worker keepalive during export', () => {
  it('starts keepalive interval during export and clears it on success', async () => {
    const ctx = buildMockContext({
      fetch: async (url) => {
        if (url.includes('/rest/api/space/')) {
          return { ok: true, status: 200, json: async () => ({ name: 'Test Space' }), headers: { get: () => '0' } };
        }
        if (url.includes('/rest/api/content?')) {
          return { ok: true, status: 200, json: async () => ({ results: [{ id: '1', title: 'Home', ancestors: [] }], _links: {} }), headers: { get: () => '0' } };
        }
        if (url.includes('/rest/api/content/')) {
          return { ok: true, status: 200, json: async () => ({ body: { view: { value: '<p>Hello</p>' } } }), headers: { get: () => '0' } };
        }
        return { ok: true, status: 200, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0), headers: { get: () => '0' } };
      },
    });
    // Responses for ensureOffscreenDocument ping + trigger-download
    ctx._sendMessageResponses.push(
      { ready: true },
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
