// ── Worker pool for parallel Turndown conversion ────────────────────────────

const WORKER_COUNT = 4;
const WORKER_TIMEOUT_MS = 10000; // 10s — kill and respawn if stuck
const workers = [];
const pendingJobs = new Map(); // id → { resolve, timer, workerIndex }
let jobIdCounter = 0;
let workerRoundRobin = 0;

function createWorker(index) {
  const w = new Worker('turndown-worker.js');
  w.onmessage = (e) => {
    const { id, markdown, error } = e.data;
    const job = pendingJobs.get(id);
    if (job) {
      clearTimeout(job.timer);
      pendingJobs.delete(id);
      job.resolve({ markdown: markdown ?? '', error });
    }
  };
  workers[index] = w;
  return w;
}

function ensureWorkers() {
  if (workers.length > 0) return;
  for (let i = 0; i < WORKER_COUNT; i++) {
    createWorker(i);
  }
}

function convertHtmlViaWorker(html) {
  ensureWorkers();
  const id = ++jobIdCounter;
  const workerIndex = workerRoundRobin % WORKER_COUNT;
  workerRoundRobin++;
  const worker = workers[workerIndex];

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      // Worker stuck — kill, respawn, resolve with empty
      pendingJobs.delete(id);
      try { workers[workerIndex].terminate(); } catch { /* ignore */ }
      createWorker(workerIndex);
      resolve({ markdown: '', error: 'timeout' });
    }, WORKER_TIMEOUT_MS);

    pendingJobs.set(id, { resolve, timer, workerIndex });
    worker.postMessage({ id, html });
  });
}

// ── Download helpers ────────────────────────────────────────────────────────

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

// ── Port-based handler for parallel Turndown (no sendMessage queue) ─────────

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'turndown') return;
  port.onMessage.addListener((msg) => {
    const { id, html } = msg;
    convertHtmlViaWorker(html).then(result => {
      try { port.postMessage({ id, markdown: result.markdown, error: result.error }); } catch { /* port closed */ }
    });
  });
});

// ── Message handler (ping, downloads) ───────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === 'ping') {
    sendResponse({ ready: true });
    return true;
  }
  if (msg.action === 'blob-chunk') {
    pendingChunks.push(msg.chunk);
    sendResponse({ ok: true });
    return true;
  }
  if (msg.action === 'trigger-download-from-chunks') {
    const base64 = pendingChunks.join('');
    pendingChunks = [];
    triggerAnchorDownload(base64, msg.filename);
    sendResponse({ ok: true });
    return true;
  }
  if (msg.action === 'trigger-download') {
    triggerAnchorDownload(msg.base64, msg.filename);
    sendResponse({ ok: true });
    return true;
  }
});
