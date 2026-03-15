import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const utilsSrc = readFileSync(join(__dir, '../../utils.js'), 'utf8');
const ctx = {};
runInNewContext(utilsSrc + '\nthis.CONFLUENCE_EMOTICON_MAP = CONFLUENCE_EMOTICON_MAP;\nthis.replaceEmojis = replaceEmojis;\n', ctx);
const { pageToFilename, pageToFolderName, buildPageIndex, computeRelativePath, rewriteInternalLinks, escapeParensForMarkdown, replaceEmojis, CONFLUENCE_EMOTICON_MAP } = ctx;

describe('pageToFilename', () => {
  it('converts spaces to hyphens', () => {
    assert.equal(pageToFilename('My Page'), 'My-Page.md');
  });

  it('strips unsafe characters', () => {
    assert.equal(pageToFilename('Page: A/B'), 'Page-AB.md');
  });

  it('collapses multiple hyphens', () => {
    assert.equal(pageToFilename('A  B'), 'A-B.md');
  });

  it('trims leading and trailing whitespace', () => {
    assert.equal(pageToFilename('  Page  '), 'Page.md');
  });

  it('caps filename at 200 chars plus .md', () => {
    const long = 'A'.repeat(300);
    const result = pageToFilename(long);
    assert.equal(result, 'A'.repeat(200) + '.md');
  });

  it('strips null bytes and control characters', () => {
    assert.equal(pageToFilename('Page\x00Name'), 'PageName.md');
  });

  it('falls back to Untitled when title is undefined', () => {
    assert.equal(pageToFilename(undefined), 'Untitled.md');
  });

  it('falls back to Untitled when title is null', () => {
    assert.equal(pageToFilename(null), 'Untitled.md');
  });

  it('falls back to Untitled when title is empty string', () => {
    assert.equal(pageToFilename(''), 'Untitled.md');
  });

  it('falls back to Untitled when title is whitespace only', () => {
    assert.equal(pageToFilename('   '), 'Untitled.md');
  });
});

describe('pageToFolderName', () => {
  it('removes .md suffix', () => {
    assert.equal(pageToFolderName('My Page'), 'My-Page');
  });

  it('applies same sanitization as pageToFilename', () => {
    assert.equal(pageToFolderName('A/B'), 'AB');
  });
});

describe('buildPageIndex', () => {
  it('indexes a root-level page with no ancestors', () => {
    const pages = [{ id: '1', title: 'Home', ancestors: [] }];
    const index = buildPageIndex(pages);
    assert.equal(index.get('1').title, 'Home');
    assert.equal(index.get('1').zipPath, 'Home.md');
  });

  it('builds nested path from ancestors', () => {
    const pages = [
      { id: '2', title: 'Child', ancestors: [{ title: 'Home' }, { title: 'Parent' }] },
    ];
    const index = buildPageIndex(pages);
    assert.equal(index.get('2').title, 'Child');
    assert.equal(index.get('2').zipPath, 'Home/Parent/Child.md');
  });

  it('handles pages with missing titles', () => {
    const pages = [
      { id: '1', title: undefined, ancestors: [] },
      { id: '2', title: 'Child', ancestors: [{ title: undefined }] },
    ];
    const index = buildPageIndex(pages);
    assert.equal(index.get('1').zipPath, 'Untitled.md');
    assert.equal(index.get('2').zipPath, 'Untitled/Child.md');
  });

  it('handles pages with null titles', () => {
    const pages = [{ id: '1', title: null, ancestors: [] }];
    const index = buildPageIndex(pages);
    assert.equal(index.get('1').zipPath, 'Untitled.md');
  });

  it('indexes multiple pages', () => {
    const pages = [
      { id: '1', title: 'Home', ancestors: [] },
      { id: '2', title: 'Child', ancestors: [{ title: 'Home' }] },
    ];
    const index = buildPageIndex(pages);
    assert.equal(index.size, 2);
    assert.equal(index.get('1').zipPath, 'Home.md');
    assert.equal(index.get('2').zipPath, 'Home/Child.md');
  });

  it('sanitizes titles in paths', () => {
    const pages = [
      { id: '1', title: 'My Page', ancestors: [] },
      { id: '2', title: 'Sub: Page', ancestors: [{ title: 'My Page' }] },
    ];
    const index = buildPageIndex(pages);
    assert.equal(index.get('2').title, 'Sub: Page');
    assert.equal(index.get('2').zipPath, 'My-Page/Sub-Page.md');
  });

  it('appends suffix for duplicate filenames in same parent', () => {
    const pages = [
      { id: '1', title: 'Page', ancestors: [] },
      { id: '2', title: 'Page', ancestors: [] },
    ];
    const index = buildPageIndex(pages);
    assert.equal(index.get('1').zipPath, 'Page.md');
    assert.equal(index.get('2').zipPath, 'Page-2.md');
  });

  it('appends incrementing suffixes for three duplicates', () => {
    const pages = [
      { id: '1', title: 'Page', ancestors: [] },
      { id: '2', title: 'Page', ancestors: [] },
      { id: '3', title: 'Page', ancestors: [] },
    ];
    const index = buildPageIndex(pages);
    assert.equal(index.get('1').zipPath, 'Page.md');
    assert.equal(index.get('2').zipPath, 'Page-2.md');
    assert.equal(index.get('3').zipPath, 'Page-3.md');
  });

  it('allows same filename in different parents without suffix', () => {
    const pages = [
      { id: '1', title: 'Page', ancestors: [{ title: 'A' }] },
      { id: '2', title: 'Page', ancestors: [{ title: 'B' }] },
    ];
    const index = buildPageIndex(pages);
    assert.equal(index.get('1').zipPath, 'A/Page.md');
    assert.equal(index.get('2').zipPath, 'B/Page.md');
  });
});

describe('computeRelativePath', () => {
  it('computes path in the same directory', () => {
    assert.equal(computeRelativePath('Home/A.md', 'Home/B.md'), 'B.md');
  });

  it('computes path up one level', () => {
    assert.equal(computeRelativePath('Home/Sub/Child.md', 'Home/Sibling.md'), '../Sibling.md');
  });

  it('computes deep cross-tree path', () => {
    assert.equal(
      computeRelativePath('Home/A/Deep.md', 'Home/B/Other/Target.md'),
      '../B/Other/Target.md',
    );
  });

  it('computes path from root to nested', () => {
    assert.equal(computeRelativePath('Root.md', 'Home/Child.md'), 'Home/Child.md');
  });

  it('computes path from nested to root', () => {
    assert.equal(computeRelativePath('Home/Child.md', 'Root.md'), '../Root.md');
  });

  it('returns filename for root-level self-reference', () => {
    assert.equal(computeRelativePath('Page.md', 'Page.md'), 'Page.md');
  });
});

describe('rewriteInternalLinks', () => {
  it('rewrites known page link by pageId in path', () => {
    const pageIndex = new Map([['123', { title: 'Target', zipPath: 'Home/Target.md' }]]);
    const html = '<a href="/spaces/SPACE/pages/123/Target">Target</a>';
    const result = rewriteInternalLinks(html, 'Home/Source.md', pageIndex);
    assert.equal(result, '<a href="Target.md">Target</a>');
  });

  it('rewrites viewpage.action links', () => {
    const pageIndex = new Map([['456', { title: 'Other', zipPath: 'Home/Sub/Other.md' }]]);
    const html = '<a href="/pages/viewpage.action?pageId=456">Other</a>';
    const result = rewriteInternalLinks(html, 'Home/Source.md', pageIndex);
    assert.equal(result, '<a href="Sub/Other.md">Other</a>');
  });

  it('leaves unknown page links unchanged', () => {
    const pageIndex = new Map();
    const html = '<a href="/spaces/SPACE/pages/999/Unknown">Unknown</a>';
    const result = rewriteInternalLinks(html, 'Home/Source.md', pageIndex);
    assert.equal(result, html);
  });

  it('leaves external links unchanged', () => {
    const pageIndex = new Map();
    const html = '<a href="https://example.com">External</a>';
    const result = rewriteInternalLinks(html, 'Home/Source.md', pageIndex);
    assert.equal(result, html);
  });
});

describe('escapeParensForMarkdown', () => {
  it('encodes parentheses as percent-encoded equivalents', () => {
    assert.equal(
      escapeParensForMarkdown('E2E PoC draft (PI Planning).png'),
      'E2E PoC draft %28PI Planning%29.png',
    );
  });

  it('returns string unchanged when no parentheses', () => {
    assert.equal(escapeParensForMarkdown('image.png'), 'image.png');
  });

  it('handles multiple pairs of parentheses', () => {
    assert.equal(
      escapeParensForMarkdown('file (a) (b).png'),
      'file %28a%29 %28b%29.png',
    );
  });

  it('handles nested parentheses', () => {
    assert.equal(
      escapeParensForMarkdown('file ((nested)).png'),
      'file %28%28nested%29%29.png',
    );
  });
});

describe('replaceEmojis', () => {
  const mockShortcodeMap = { tada: '🎉', heart: '❤️', '+1': '👍' };

  it('replaces Confluence emoticon img with Unicode', () => {
    const html = '<p>Good <img class="emoticon" src="/s/abc/images/icons/emoticons/thumbs_up.svg" alt="thumbs up"> work</p>';
    assert.equal(replaceEmojis(html, {}), '<p>Good 👍 work</p>');
  });

  it('replaces Twitter emoji redirector img with Unicode', () => {
    const html = '<p>Party <img class="emoji" src="/plugins/servlet/twitterEmojiRedirector?shortname=:tada:&size=16" alt="tada"></p>';
    assert.equal(replaceEmojis(html, mockShortcodeMap), '<p>Party 🎉</p>');
  });

  it('replaces both types in the same HTML', () => {
    const html = '<img src="/s/x/images/icons/emoticons/smile.svg"> <img src="/x/twitterEmojiRedirector?shortname=:heart:&size=16">';
    const result = replaceEmojis(html, mockShortcodeMap);
    assert.equal(result, '🙂 ❤️');
  });

  it('handles .png emoticon extension', () => {
    const html = '<img src="/s/abc/images/icons/emoticons/check.png">';
    assert.equal(replaceEmojis(html, {}), '✅');
  });

  it('preserves unrecognized emoticon filenames', () => {
    const html = '<img src="/s/abc/images/icons/emoticons/unknown_thing.svg">';
    assert.equal(replaceEmojis(html, {}), html);
  });

  it('preserves unrecognized Twitter emoji shortcodes', () => {
    const html = '<img src="/x/twitterEmojiRedirector?shortname=:nonexistent_emoji_xyz:&size=16">';
    assert.equal(replaceEmojis(html, mockShortcodeMap), html);
  });

  it('handles emoticon img with extra attributes', () => {
    const html = '<img class="emoticon emoticon-tick" data-emoticon-name="tick" src="/s/abc/images/icons/emoticons/check.svg" alt="(tick)" title="(tick)">';
    assert.equal(replaceEmojis(html, {}), '✅');
  });

  it('replaces all 22 Confluence emoticons', () => {
    for (const [filename, emoji] of Object.entries(CONFLUENCE_EMOTICON_MAP)) {
      const html = `<img src="/s/x/images/icons/emoticons/${filename}.svg">`;
      assert.equal(replaceEmojis(html, {}), emoji, `${filename} should map to ${emoji}`);
    }
  });

  it('does not touch regular attachment images', () => {
    const html = '<img src="/download/attachments/123/diagram.png" alt="Diagram">';
    assert.equal(replaceEmojis(html, mockShortcodeMap), html);
  });
});
