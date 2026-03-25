// ── DOM refs ────────────────────────────────────────────────────────────────

const btnExport = document.getElementById('btn-export');
const btnSelectAll = document.getElementById('btn-select-all');
const btnDeselectAll = document.getElementById('btn-deselect-all');

const selectCount = document.getElementById('select-count');
const treeLoading = document.getElementById('tree-loading');
const treeContent = document.getElementById('tree-content');
const treeSearch = document.getElementById('tree-search');
const progressSection = document.getElementById('progress-section');
const progressBar = document.getElementById('progress-bar');
const btnCancel = document.getElementById('btn-cancel');
const activeThreadsEl = document.getElementById('active-threads');
const status = document.getElementById('status');
const spaceInfo = document.getElementById('space-info');
const spaceNameEl = document.getElementById('space-name');
const chkAttachments = document.getElementById('chk-attachments');
const maxAttachmentSelect = document.getElementById('max-attachment-size');
const chkOrder = document.getElementById('chk-order');
const chkIncremental = document.getElementById('chk-incremental');

// ── State ───────────────────────────────────────────────────────────────────

let treeData = null;
let currentPageId = null;
const selectedPageIds = new Set();

// ── Tree loading ────────────────────────────────────────────────────────────

async function loadTree() {
  treeLoading.hidden = false;
  treeContent.hidden = true;

  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const port = chrome.runtime.connect({ name: 'export' });

  port.onMessage.addListener((msg) => {
    if (msg.type === 'tree-loading') {
      treeLoading.querySelector('span').textContent = msg.message;
    } else if (msg.type === 'tree-data') {
      treeData = msg.tree;
      currentPageId = msg.currentPageId;

      spaceInfo.hidden = false;
      spaceNameEl.textContent = `${msg.spaceName} (${msg.totalPages})`;

      renderTree(msg.tree);
      treeLoading.hidden = true;
      treeContent.hidden = false;

      btnSelectAll.disabled = false;
      btnDeselectAll.disabled = false;
      treeSearch.disabled = false;

      // Pre-select current page
      if (currentPageId) {
        const currentNode = findNodeById(treeData, String(currentPageId));
        if (currentNode) {
          toggleNodeSelection(currentNode, true);
          updateSelectCount();
          updateExportButton();
        }
      }
    } else if (msg.type === 'tree-blocked') {
      treeLoading.querySelector('span').textContent = 'Дерево загрузится после экспорта...';
      const spinner = treeLoading.querySelector('.spinner');
      if (spinner) spinner.style.display = 'none';
    } else if (msg.type === 'error') {
      treeLoading.querySelector('span').textContent = msg.message;
      const spinner = treeLoading.querySelector('.spinner');
      if (spinner) spinner.remove();
    }
  });

  port.postMessage({ action: 'fetch-tree', tabId: tab?.id, tabUrl: tab?.url });
}

// ── Tree search ─────────────────────────────────────────────────────────────

let searchTimeout = null;
treeSearch.addEventListener('input', () => {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => {
    applyTreeSearch(treeSearch.value.trim().toLowerCase());
  }, 150);
});

function applyTreeSearch(query) {
  if (!treeData) return;

  const allNodes = treeContent.querySelectorAll('.tree-node');
  if (!query) {
    allNodes.forEach(n => n.classList.remove('search-hidden'));
    return;
  }

  allNodes.forEach(n => n.classList.add('search-hidden'));

  allNodes.forEach(node => {
    const label = node.querySelector(':scope > .tree-row > .tree-label');
    if (!label) return;
    if (label.textContent.toLowerCase().includes(query)) {
      let el = node;
      while (el) {
        el.classList.remove('search-hidden');
        const parentChildren = el.parentElement;
        if (parentChildren && parentChildren.classList.contains('tree-children')) {
          parentChildren.classList.remove('collapsed');
        }
        el = parentChildren?.closest('.tree-node') ?? null;
      }
    }
  });
}

// ── Tree rendering ──────────────────────────────────────────────────────────

function findNodeById(nodes, id) {
  for (const n of nodes) {
    if (String(n.id) === id) return n;
    if (n.children) {
      const found = findNodeById(n.children, id);
      if (found) return found;
    }
  }
  return null;
}

function clearElement(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

function countDescendants(node) {
  let count = 0;
  if (node.children) {
    count += node.children.length;
    for (const child of node.children) {
      count += countDescendants(child);
    }
  }
  return count;
}

function renderTree(nodes) {
  clearElement(treeContent);
  for (const node of nodes) {
    treeContent.appendChild(createTreeNode(node, 0));
  }
}

function createTreeNode(node, depth) {
  const container = document.createElement('div');
  container.className = 'tree-node';
  container.dataset.id = node.id;

  const row = document.createElement('div');
  row.className = 'tree-row';
  if (String(node.id) === String(currentPageId)) {
    row.classList.add('current-page');
  }
  row.style.paddingLeft = `${8 + depth * 16}px`;

  const toggle = document.createElement('button');
  toggle.className = 'tree-toggle';
  const hasChildren = node.children && node.children.length > 0;
  if (hasChildren) {
    toggle.textContent = '\u25B6';
    toggle.classList.add('expanded');
  } else {
    toggle.classList.add('leaf');
  }

  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.className = 'tree-checkbox';
  checkbox.dataset.id = node.id;
  checkbox.addEventListener('change', () => {
    toggleNodeSelection(node, checkbox.checked);
    updateSelectCount();
    updateExportButton();
  });

  const label = document.createElement('span');
  label.className = 'tree-label';
  label.textContent = node.title;
  label.title = node.title;

  row.appendChild(toggle);
  row.appendChild(checkbox);
  row.appendChild(label);

  if (hasChildren) {
    const count = countDescendants(node);
    const badge = document.createElement('span');
    badge.className = 'tree-count';
    badge.textContent = `${count}`;
    row.appendChild(badge);
  }

  container.appendChild(row);

  if (hasChildren) {
    const childrenContainer = document.createElement('div');
    childrenContainer.className = 'tree-children';
    for (const child of node.children) {
      childrenContainer.appendChild(createTreeNode(child, depth + 1));
    }
    container.appendChild(childrenContainer);

    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      toggle.classList.toggle('expanded');
      childrenContainer.classList.toggle('collapsed');
    });
  }

  row.addEventListener('click', (e) => {
    if (e.target === checkbox || e.target === toggle) return;
    checkbox.checked = !checkbox.checked;
    checkbox.dispatchEvent(new Event('change'));
  });

  return container;
}

function toggleNodeSelection(node, selected) {
  if (selected) {
    selectedPageIds.add(String(node.id));
  } else {
    selectedPageIds.delete(String(node.id));
  }

  const cb = treeContent.querySelector(`input[data-id="${node.id}"]`);
  if (cb) cb.checked = selected;

  if (node.children) {
    for (const child of node.children) {
      toggleNodeSelection(child, selected);
    }
  }
}

function updateSelectCount() {
  selectCount.textContent = `${selectedPageIds.size} выбрано`;
}

function updateExportButton() {
  btnExport.disabled = selectedPageIds.size === 0;
}

// ── Select All / Deselect All ───────────────────────────────────────────────

btnSelectAll.addEventListener('click', () => {
  if (!treeData) return;
  function selectAll(nodes) {
    for (const n of nodes) {
      selectedPageIds.add(String(n.id));
      const cb = treeContent.querySelector(`input[data-id="${n.id}"]`);
      if (cb) cb.checked = true;
      if (n.children) selectAll(n.children);
    }
  }
  selectAll(treeData);
  updateSelectCount();
  updateExportButton();
});

btnDeselectAll.addEventListener('click', () => {
  selectedPageIds.clear();
  treeContent.querySelectorAll('input[type="checkbox"]').forEach(cb => { cb.checked = false; });
  updateSelectCount();
  updateExportButton();
});

// ── Settings persistence ────────────────────────────────────────────────────

function toggleAttachmentSize() {
  maxAttachmentSelect.hidden = !chkAttachments.checked;
}

function saveSettings() {
  chrome.storage.local.set({
    downloadAttachments: chkAttachments.checked,
    maxAttachmentBytes: parseInt(maxAttachmentSelect.value, 10),
    preserveOrder: chkOrder.checked,
    incremental: chkIncremental.checked,
  });
}

chkAttachments.addEventListener('change', () => { toggleAttachmentSize(); saveSettings(); });
maxAttachmentSelect.addEventListener('change', saveSettings);
chkOrder.addEventListener('change', saveSettings);
chkIncremental.addEventListener('change', saveSettings);

(async () => {
  try {
    const data = await chrome.storage.local.get(['downloadAttachments', 'maxAttachmentBytes', 'preserveOrder', 'incremental']);
    if (data.downloadAttachments === true) chkAttachments.checked = true;
    if (data.maxAttachmentBytes !== undefined) maxAttachmentSelect.value = String(data.maxAttachmentBytes);
    if (data.preserveOrder === true) chkOrder.checked = true;
    if (data.incremental === true) chkIncremental.checked = true;
    toggleAttachmentSize();
  } catch { /* ignore */ }
})();

// ── Export ───────────────────────────────────────────────────────────────────

function showProgress() {
  progressSection.hidden = false;
  progressBar.style.width = '0%';
  btnCancel.hidden = false;
  progressStartTime = null;
  status.className = 'status-text';
  status.textContent = 'Starting...';
}

let progressStartTime = null;
function handlePortMessage(msg) {
  const { type, current, total, message, threads } = msg;
  if (type === 'progress') {
    status.className = 'status-text';
    status.textContent = message ?? 'Working...';
    if (typeof current === 'number' && typeof total === 'number' && total > 0) {
      if (!progressStartTime) progressStartTime = Date.now();
      const pct = Math.round((current / total) * 100);
      progressBar.style.width = `${pct}%`;
      const elapsed = (Date.now() - progressStartTime) / 1000;
      const pagesPerSec = elapsed > 0 ? (current / elapsed).toFixed(1) : '—';
      const remaining = elapsed > 0 ? Math.round((total - current) / (current / elapsed)) : '—';
      status.textContent = `${current}/${total} готово · ${pagesPerSec}/s · ~${remaining}s`;
    }
  } else if (type === 'threads') {
    renderThreads(threads);
    return;
  } else if (type === 'done') {
    status.className = 'status-text success';
    status.textContent = message ?? 'Done!';
    progressBar.style.width = '100%';
    btnCancel.hidden = true;
    activeThreadsEl.hidden = true;
    btnExport.disabled = false;
  } else if (type === 'error') {
    status.className = 'status-text error';
    status.textContent = message ?? 'An error occurred.';
    btnCancel.hidden = true;
    activeThreadsEl.hidden = true;
    btnExport.disabled = false;
  }
}

const PHASE_LABELS = {
  fetching: 'fetch',
  converting: 'md',
  attachments: 'img',
};

function renderThreads(threads) {
  if (!threads || threads.length === 0) {
    activeThreadsEl.hidden = true;
    return;
  }
  activeThreadsEl.hidden = false;
  // Reuse existing rows where possible
  while (activeThreadsEl.children.length > threads.length) {
    activeThreadsEl.removeChild(activeThreadsEl.lastChild);
  }
  for (let i = 0; i < threads.length; i++) {
    const t = threads[i];
    let row = activeThreadsEl.children[i];
    if (!row) {
      row = document.createElement('div');
      row.className = 'thread-row';
      const dot = document.createElement('span');
      dot.className = 'thread-status';
      const label = document.createElement('span');
      label.className = 'thread-label';
      const phase = document.createElement('span');
      phase.className = 'thread-phase';
      row.appendChild(dot);
      row.appendChild(label);
      row.appendChild(phase);
      activeThreadsEl.appendChild(row);
    }
    const dot = row.children[0];
    const label = row.children[1];
    const phase = row.children[2];
    dot.className = `thread-status ${t.phase}`;
    label.textContent = t.title;
    label.title = t.title;
    phase.textContent = PHASE_LABELS[t.phase] ?? t.phase;
  }
}

let activeExportPort = null;

btnExport.addEventListener('click', async () => {
  btnExport.disabled = true;
  showProgress();

  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const port = chrome.runtime.connect({ name: 'export' });
  activeExportPort = port;
  port.onMessage.addListener(handlePortMessage);
  port.postMessage({
    action: 'export-selected',
    tabId: tab?.id,
    tabUrl: tab?.url,
    pageIds: Array.from(selectedPageIds),
    skipAttachments: !chkAttachments.checked,
    maxAttachmentBytes: chkAttachments.checked ? (parseInt(maxAttachmentSelect.value, 10) || 0) : 0,
    preserveOrder: chkOrder.checked,
    incremental: chkIncremental.checked,
  });
});

btnCancel.addEventListener('click', () => {
  if (activeExportPort) {
    activeExportPort.postMessage({ action: 'cancel' });
  }
});

// ── Copy logs ───────────────────────────────────────────────────────────────

document.getElementById('btn-logs').addEventListener('click', async () => {
  const port = chrome.runtime.connect({ name: 'export' });
  port.onMessage.addListener((msg) => {
    if (msg.type === 'logs') {
      const text = msg.logs.map(e => `${e.t} [${e.l}] ${e.m}${e.d ? ' ' + JSON.stringify(e.d) : ''}`).join('\n');
      navigator.clipboard.writeText(text).then(() => {
        document.getElementById('btn-logs').textContent = 'copied!';
        setTimeout(() => { document.getElementById('btn-logs').textContent = 'logs'; }, 2000);
      });
    }
  });
  port.postMessage({ action: 'get-logs' });
});

// ── Load tree on startup ────────────────────────────────────────────────────

loadTree();

// ── Restore export state on popup open ──────────────────────────────────────

(async () => {
  try {
    const statusPort = chrome.runtime.connect({ name: 'export' });
    activeExportPort = statusPort;
    statusPort.onMessage.addListener((msg) => {
      if (msg.type === 'progress' || msg.type === 'done' || msg.type === 'error' || msg.type === 'threads') {
        progressSection.hidden = false;
        if (msg.type === 'progress') {
          btnCancel.hidden = false;
          btnExport.disabled = true;
          if (!progressStartTime) progressStartTime = Date.now(); // init timer on restore
        }
        handlePortMessage(msg);
      }
    });
    statusPort.postMessage({ action: 'get-status' });

    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.url) return;

    const url = tab.url;
    const isConfluence = url.includes('/wiki/') ||
      url.includes('/confluence/') ||
      url.includes('/display/') ||
      url.includes('/pages/') ||
      url.includes('pageId=');

    if (!isConfluence) {
      status.textContent = 'Open a Confluence page to export.';
      status.className = 'status-text';
      progressSection.hidden = false;
    }
  } catch {
    // Ignore detection errors on popup open
  }
})();
