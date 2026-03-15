/* exported pageToFilename, pageToFolderName, buildPageIndex */

const UNSAFE_CHARS = /[<>:"/\\|?*\x00-\x1F]/g;

function pageToFilename(title) {
  return title.trim()
    .replace(UNSAFE_CHARS, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 200)
    + '.md';
}

function pageToFolderName(title) {
  return pageToFilename(title).replace(/\.md$/, '');
}

function buildPageIndex(pages) {
  const index = new Map();
  for (const page of pages) {
    const folderParts = page.ancestors.map(a => pageToFolderName(a.title));
    const filename = pageToFilename(page.title);
    const zipPath = [...folderParts, filename].join('/');
    index.set(page.id, { title: page.title, zipPath });
  }
  return index;
}
