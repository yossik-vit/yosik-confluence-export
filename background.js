chrome.runtime.onInstalled.addListener(() => {
  console.log("Extension installed.");
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "RUN") {
    handleRun(message).then(sendResponse);
    return true; // keep the message channel open for async response
  }
});

async function handleRun({ tabId, url }) {
  console.log("handleRun called for tab", tabId, url);

  // TODO: implement your core logic here.
  // Example: inject a content script, fetch data, trigger a download, etc.
  //
  // To trigger a download:
  // await chrome.downloads.download({ url: "...", filename: "export.json" });

  return { message: "Done" };
}
