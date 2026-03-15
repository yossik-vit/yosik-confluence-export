chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action !== 'download-zip') return;
  const blob = new Blob([msg.arrayBuffer], { type: 'application/zip' });
  const url = URL.createObjectURL(blob);
  chrome.downloads.download({ url, filename: msg.filename }, () => {
    URL.revokeObjectURL(url);
  });
});
