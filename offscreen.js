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

// sendMessage handler: ping + download triggers only
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
