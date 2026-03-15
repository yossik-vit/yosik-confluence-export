const turndown = (() => {
  const td = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
  });
  td.use(turndownPluginGfm.gfm);
  return td;
})();

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
  if (msg.action === 'ping') {
    sendResponse({ ready: true });
    return true;
  }
  if (msg.action === 'convert-html') {
    try {
      const markdown = turndown.turndown(msg.html);
      sendResponse({ markdown });
    } catch (err) {
      sendResponse({ markdown: '', error: err.message });
    }
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
