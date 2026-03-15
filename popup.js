const btn = document.getElementById("action-btn");
const status = document.getElementById("status");

btn.addEventListener("click", async () => {
  btn.disabled = true;
  status.textContent = "Working...";

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    // Send a message to the background service worker
    const response = await chrome.runtime.sendMessage({
      type: "RUN",
      tabId: tab.id,
      url: tab.url,
    });

    status.textContent = response?.message ?? "Done";
  } catch (err) {
    status.textContent = `Error: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
});
