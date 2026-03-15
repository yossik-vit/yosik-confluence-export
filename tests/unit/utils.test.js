import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const utilsSrc = readFileSync(join(__dir, '../../utils.js'), 'utf8');
const ctx = {};
runInNewContext(utilsSrc, ctx);
const { pageToFilename, pageToFolderName, buildPageIndex } = ctx;

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
});
