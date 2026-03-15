const btn = document.getElementById('action-btn');
const status = document.getElementById('status');
const progressWrap = document.getElementById('progress-bar-wrap');
const progressBar = document.getElementById('progress-bar');

btn.addEventListener('click', () => {
  btn.disabled = true;
  progressWrap.hidden = true;
  progressBar.style.width = '0%';

  const port = chrome.runtime.connect({ name: 'export' });

  port.onMessage.addListener(({ type, current, total, message }) => {
    if (type === 'progress') {
      status.textContent = message ?? 'Working…';
      if (typeof current === 'number' && typeof total === 'number' && total > 0) {
        progressWrap.hidden = false;
        progressBar.style.width = `${Math.round((current / total) * 100)}%`;
        status.textContent = `${message} (${current}/${total})`;
      }
    } else if (type === 'done') {
      status.textContent = message ?? 'Done!';
      progressWrap.hidden = true;
      btn.disabled = false;
    } else if (type === 'error') {
      status.textContent = message ?? 'An error occurred.';
      progressWrap.hidden = true;
      btn.disabled = false;
    }
  });

  port.postMessage({ action: 'start' });
});
