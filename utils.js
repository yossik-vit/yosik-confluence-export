/* exported pageToFilename, pageToFolderName, buildPageIndex, computeRelativePath, rewriteInternalLinks, escapeParensForMarkdown, replaceEmojis, CONFLUENCE_EMOTICON_MAP, sanitizeZipPathSegment, sanitizeZipFilename */

const UNSAFE_CHARS = /[<>:"/\\|?*\x00-\x1F]/g;
const COMBINING_MARKS = /[\u0300-\u036f]/g;
// Keep Unicode letters/numbers (Cyrillic, CJK, etc.) — only strip control/special chars
const NON_SAFE_CHARS = /[^\p{L}\p{N}!#$%&'()+,.;=@[\]^_`{}~ -]/gu;
const FALLBACK_TITLE = 'Untitled';
const FALLBACK_ATTACHMENT_NAME = 'file';

function sanitizeZipPathSegment(value, fallback = FALLBACK_TITLE) {
  const safe = (value ?? '')
    .normalize('NFC')  // NFC preserves Cyrillic; NFKD would decompose accented Latin
    .replace(/\uFFFD/g, '')
    .replace(UNSAFE_CHARS, '')
    .replace(NON_SAFE_CHARS, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');

  return safe || fallback;
}

function sanitizeZipFilename(filename, fallback = FALLBACK_ATTACHMENT_NAME) {
  const safe = (filename ?? '').trim();
  const dotIndex = safe.lastIndexOf('.');
  const hasExtension = dotIndex > 0 && dotIndex < safe.length - 1;
  const basename = hasExtension ? safe.slice(0, dotIndex) : safe;
  const extension = hasExtension
    ? safe
      .slice(dotIndex + 1)
      .normalize('NFKD')
      .replace(COMBINING_MARKS, '')
      .replace(/\uFFFD/g, '')
      .replace(/[^A-Za-z0-9]/g, '')
    : '';
  const safeBasename = sanitizeZipPathSegment(basename, fallback);
  return extension ? `${safeBasename}.${extension}` : safeBasename;
}

function pageToFilename(title) {
  return sanitizeZipPathSegment(title)
    .slice(0, 200)
    + '.md';
}

function pageToFolderName(title) {
  return pageToFilename(title).replace(/\.md$/, '');
}

function buildPageIndex(pages, rootFolder, preserveOrder) {
  // Build set of parent IDs to know which pages have children
  const parentIds = new Set();
  for (const page of pages) {
    if (page.ancestors && page.ancestors.length > 0) {
      parentIds.add(page.ancestors[page.ancestors.length - 1].id);
    }
  }

  // Build sibling order: for each parent, track the position of each child
  // Confluence API returns pages in their manual sort order
  const siblingOrder = new Map(); // pageId → zero-based position among siblings
  if (preserveOrder) {
    const childrenByParent = new Map(); // parentId → [pageId, ...]
    for (const page of pages) {
      const parentId = (page.ancestors && page.ancestors.length > 0)
        ? page.ancestors[page.ancestors.length - 1].id
        : '__root__';
      if (!childrenByParent.has(parentId)) childrenByParent.set(parentId, []);
      childrenByParent.get(parentId).push(page.id);
    }
    for (const children of childrenByParent.values()) {
      for (let i = 0; i < children.length; i++) {
        siblingOrder.set(children[i], i);
      }
    }
  }

  const index = new Map();
  const pathsSeen = new Set();
  for (const page of pages) {
    const folderParts = page.ancestors.map(a => pageToFolderName(a.title));
    if (rootFolder) folderParts.unshift(rootFolder);

    // Folder note convention: if page has children, place it inside its own folder
    const isParent = parentIds.has(page.id);
    if (isParent) {
      folderParts.push(pageToFolderName(page.title));
    }

    // Optional sort prefix: "01-Title.md"
    let filename;
    if (preserveOrder && siblingOrder.has(page.id)) {
      // Folder notes (parent pages) get 00- to sort first in their folder
      const prefix = isParent ? '00' : String(siblingOrder.get(page.id) + 1).padStart(2, '0');
      filename = `${prefix}-${pageToFilename(page.title)}`;
    } else {
      filename = pageToFilename(page.title);
    }

    let candidate = [...folderParts, filename].join('/');
    let suffix = 2;
    while (pathsSeen.has(candidate)) {
      const base = pageToFilename(page.title).replace('.md', `-${suffix}.md`);
      filename = preserveOrder && siblingOrder.has(page.id)
        ? `${String(siblingOrder.get(page.id) + 1).padStart(2, '0')}-${base}`
        : base;
      candidate = [...folderParts, filename].join('/');
      suffix++;
    }
    pathsSeen.add(candidate);
    index.set(page.id, { title: page.title, zipPath: candidate });
  }
  return index;
}

function computeRelativePath(fromZipPath, toZipPath) {
  const fromParts = fromZipPath.split('/').slice(0, -1);
  const toParts = toZipPath.split('/');
  let shared = 0;
  for (let i = 0; i < Math.min(fromParts.length, toParts.length); i++) {
    if (fromParts[i] === toParts[i]) shared = i + 1;
    else break;
  }
  const up = fromParts.length - shared;
  const rel = [...Array(up).fill('..'), ...toParts.slice(shared)].join('/');
  return rel || './' + toParts.at(-1);
}

function escapeParensForMarkdown(str) {
  return str.replace(/\(/g, '%28').replace(/\)/g, '%29');
}

const PAGE_HREF_RE = /\/pages\/(\d+)|[?&]pageId=(\d+)/;

/**
 * Maps Confluence built-in emoticon image filenames (without extension)
 * to Unicode emoji characters. Covers all 22 built-in emoticons.
 */
const CONFLUENCE_EMOTICON_MAP = {
  'smile':         '\u{1F642}',  // 🙂
  'sad':           '\u{1F61E}',  // 😞
  'tongue':        '\u{1F61B}',  // 😛 (ac:name "cheeky")
  'biggrin':       '\u{1F603}',  // 😃 (ac:name "laugh")
  'wink':          '\u{1F609}',  // 😉
  'thumbs_up':     '\u{1F44D}',  // 👍
  'thumbs_down':   '\u{1F44E}',  // 👎
  'information':   '\u{2139}\u{FE0F}',  // ℹ️
  'check':         '\u{2705}',   // ✅ (ac:name "tick")
  'error':         '\u{274C}',   // ❌ (ac:name "cross")
  'warning':       '\u{26A0}\u{FE0F}',  // ⚠️
  'add':           '\u{2795}',   // ➕ (ac:name "plus")
  'forbidden':     '\u{26D4}',   // ⛔ (ac:name "minus")
  'help_16':       '\u{2753}',   // ❓ (ac:name "question")
  'lightbulb_on':  '\u{1F4A1}',  // 💡 (ac:name "light-on")
  'lightbulb':     '\u{1F4A1}',  // 💡 (ac:name "light-off", dim variant)
  'star_yellow':   '\u{2B50}',   // ⭐
  'star_red':      '\u{1F534}',  // 🔴
  'star_green':    '\u{1F7E2}',  // 🟢
  'star_blue':     '\u{1F535}',  // 🔵
  'heart':         '\u{2764}\u{FE0F}',  // ❤️
  'broken_heart':  '\u{1F494}',  // 💔
};

const EMOTICON_IMG_RE = /<img\s[^>]*src="[^"]*\/images\/icons\/emoticons\/([^."]+)\.[^"]*"[^>]*>/gi;
const TWITTER_EMOJI_IMG_RE = /<img\s[^>]*src="[^"]*twitterEmojiRedirector\?shortname=:([^:]+):[^"]*"[^>]*>/gi;

/**
 * Replace Confluence emoticon and Twitter emoji <img> tags with Unicode characters.
 * @param {string} html - Raw HTML from body.view
 * @param {Object} shortcodeMap - Map of shortcode → Unicode (from vendor/emoji-map.js)
 * @returns {string} HTML with emoji <img> tags replaced by Unicode characters
 */
function replaceEmojis(html, shortcodeMap) {
  html = html.replace(EMOTICON_IMG_RE, (_match, filename) => {
    return CONFLUENCE_EMOTICON_MAP[filename] ?? _match;
  });

  html = html.replace(TWITTER_EMOJI_IMG_RE, (_match, shortname) => {
    return shortcodeMap[shortname] ?? _match;
  });

  return html;
}

function rewriteInternalLinks(html, sourceZipPath, pageIndex) {
  return html.replace(/<a\s+([^>]*href="([^"]*)"[^>]*)>/gi, (match, _attrs, href) => {
    const m = href.match(PAGE_HREF_RE);
    if (!m) return match;
    const pageId = m[1] ?? m[2];
    const target = pageIndex.get(pageId);
    if (!target) return match;
    const rel = computeRelativePath(sourceZipPath, target.zipPath);
    return match.replace(href, rel);
  });
}
