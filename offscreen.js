const turndown = (() => {
  const td = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
  });
  td.use(turndownPluginGfm.gfm);
  return td;
})();

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
  if (msg.action === 'create-blob-from-chunks') {
    const base64 = pendingChunks.join('');
    pendingChunks = [];
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const blob = new Blob([bytes], { type: 'application/zip' });
    sendResponse({ blobUrl: URL.createObjectURL(blob) });
    return true;
  }
  if (msg.action === 'create-blob-url') {
    const binary = atob(msg.base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const blob = new Blob([bytes], { type: 'application/zip' });
    sendResponse({ blobUrl: URL.createObjectURL(blob) });
    return true;
  }
  if (msg.action === 'revoke-blob-url') {
    URL.revokeObjectURL(msg.url);
    sendResponse({ ok: true });
    return true;
  }
});
