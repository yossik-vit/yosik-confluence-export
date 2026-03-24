import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const offscreenSrc = readFileSync(join(__dir, '../../offscreen.js'), 'utf8');

function buildMockContext() {
  const createdAnchors = [];
  const revokedUrls = [];
  let blobCounter = 0;
  const listeners = [];

  const ctx = {
    // TurndownService stub
    TurndownService: class {
      use() {}
      addRule() {}
      turndown(html) { return html; }
    },
    turndownPluginGfm: { gfm: {} },
    addConfluenceTurndownRules() {},

    // DOM stubs
    atob(b64) { return Buffer.from(b64, 'base64').toString('binary'); },
    Uint8Array,
    Blob: class {},
    URL: {
      createObjectURL() {
        blobCounter++;
        return `blob:chrome-extension://fake/${blobCounter}`;
      },
      revokeObjectURL(url) { revokedUrls.push(url); },
    },
    document: {
      createElement(tag) {
        const el = { tagName: tag, href: '', download: '', click() { this._clicked = true; }, remove() { this._removed = true; }, _clicked: false, _removed: false };
        createdAnchors.push(el);
        return el;
      },
      body: {
        appendChild() {},
      },
    },
    setTimeout(fn) { fn(); },

    // Worker stub (turndown workers not needed for download tests)
    Worker: class {
      constructor() { this.onmessage = null; }
      postMessage() {}
      terminate() {}
    },
    Map,
    Promise,
    clearTimeout,

    // Chrome runtime stub
    chrome: {
      runtime: {
        onMessage: {
          addListener(fn) { listeners.push(fn); },
        },
        onConnect: {
          addListener() {},
        },
      },
    },

    // Expose test helpers
    _createdAnchors: createdAnchors,
    _revokedUrls: revokedUrls,
    _listeners: listeners,
  };

  return ctx;
}

function sendMessage(ctx, msg) {
  return new Promise((resolve) => {
    for (const listener of ctx._listeners) {
      listener(msg, {}, resolve);
    }
  });
}

describe('offscreen trigger-download', () => {
  let ctx;

  beforeEach(() => {
    ctx = buildMockContext();
    runInNewContext(offscreenSrc, ctx);
  });

  it('creates anchor with correct download filename', async () => {
    const base64 = Buffer.from('fake-zip-data').toString('base64');
    await sendMessage(ctx, { action: 'trigger-download', base64, filename: 'My-Space.zip' });

    assert.equal(ctx._createdAnchors.length, 1);
    const anchor = ctx._createdAnchors[0];
    assert.equal(anchor.download, 'My-Space.zip');
    assert.ok(anchor.href.startsWith('blob:'));
    assert.ok(anchor._clicked);
    assert.ok(anchor._removed);
  });

  it('revokes the blob URL after download', async () => {
    const base64 = Buffer.from('data').toString('base64');
    await sendMessage(ctx, { action: 'trigger-download', base64, filename: 'test.zip' });

    assert.equal(ctx._revokedUrls.length, 1);
    assert.ok(ctx._revokedUrls[0].startsWith('blob:'));
  });

  it('trigger-download-from-chunks assembles chunks and downloads', async () => {
    const part1 = Buffer.from('hello').toString('base64');
    const part2 = Buffer.from(' world').toString('base64');

    await sendMessage(ctx, { action: 'blob-chunk', chunk: part1 });
    await sendMessage(ctx, { action: 'blob-chunk', chunk: part2 });
    await sendMessage(ctx, { action: 'trigger-download-from-chunks', filename: 'Space-1.zip' });

    assert.equal(ctx._createdAnchors.length, 1);
    const anchor = ctx._createdAnchors[0];
    assert.equal(anchor.download, 'Space-1.zip');
    assert.ok(anchor._clicked);
  });

  it('clears pending chunks after trigger-download-from-chunks', async () => {
    const chunk = Buffer.from('data').toString('base64');

    await sendMessage(ctx, { action: 'blob-chunk', chunk });
    await sendMessage(ctx, { action: 'trigger-download-from-chunks', filename: 'a.zip' });

    // Second download with new chunks should not include old data
    const chunk2 = Buffer.from('other').toString('base64');
    await sendMessage(ctx, { action: 'blob-chunk', chunk: chunk2 });
    await sendMessage(ctx, { action: 'trigger-download-from-chunks', filename: 'b.zip' });

    assert.equal(ctx._createdAnchors.length, 2);
    assert.equal(ctx._createdAnchors[1].download, 'b.zip');
  });
});
