/* Web Worker for parallel Turndown HTML→Markdown conversion */

importScripts('vendor/turndown.js', 'vendor/turndown-plugin-gfm.js', 'confluence-turndown-rules.js');

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
    const isStrayPipe = line.trim() === '|';

    if (isStrayPipe) continue;

    if (isTableRow && i > 0) {
      const prevLine = result[result.length - 1] ?? '';
      const prevIsTable = prevLine.trimStart().startsWith('|') && prevLine.trimEnd().endsWith('|');
      if (!prevIsTable && prevLine.trim() !== '') {
        result.push('');
      }
    }

    result.push(line);
  }

  return result.join('\n');
}

self.onmessage = (e) => {
  const { id, html } = e.data;
  try {
    let markdown = turndown.turndown(html);
    markdown = fixMarkdownTables(markdown);
    self.postMessage({ id, markdown });
  } catch (err) {
    self.postMessage({ id, markdown: '', error: err.message });
  }
};
