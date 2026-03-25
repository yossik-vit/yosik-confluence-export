const chromeGlobal = { chrome: 'readonly' };
const browserGlobals = {
  document: 'readonly',
  window: 'readonly',
  URL: 'readonly',
  Blob: 'readonly',
  Uint8Array: 'readonly',
  atob: 'readonly',
  fetch: 'readonly',
  console: 'readonly',
};
const offscreenGlobals = {
  TurndownService: 'readonly',
  turndownPluginGfm: 'readonly',
  addConfluenceTurndownRules: 'readonly',
  setTimeout: 'readonly',
};
const swGlobals = {
  importScripts: 'readonly',
  JSZip: 'readonly',
  fetch: 'readonly',
  URL: 'readonly',
  console: 'readonly',
  Promise: 'readonly',
  Map: 'readonly',
  Set: 'readonly',
  setTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  // from utils.js (loaded via importScripts)
  sanitizeZipPathSegment: 'readonly',
  sanitizeZipFilename: 'readonly',
  pageToFilename: 'readonly',
  pageToFolderName: 'readonly',
  buildPageIndex: 'readonly',
  computeRelativePath: 'readonly',
  rewriteInternalLinks: 'readonly',
  escapeParensForMarkdown: 'readonly',
  replaceEmojis: 'readonly',
  CONFLUENCE_EMOTICON_MAP: 'readonly',
  // from vendor/emoji-map.js (loaded via importScripts)
  EMOJI_SHORTCODE_MAP: 'readonly',
  AbortController: 'readonly',
  clearTimeout: 'readonly',
};

export default [
  {
    ignores: ['vendor/**', 'node_modules/**'],
  },
  {
    files: ['popup.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: { ...chromeGlobal, ...browserGlobals, Event: 'readonly', Set: 'readonly', Array: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly', parseInt: 'readonly', navigator: 'readonly' },
    },
    rules: {
      'no-unused-vars': 'error',
      'no-undef': 'error',
      'eqeqeq': 'error',
      'no-var': 'error',
      'prefer-const': 'error',
    },
  },
  {
    files: ['offscreen.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: { ...chromeGlobal, ...browserGlobals, ...offscreenGlobals },
    },
    rules: {
      'no-unused-vars': 'error',
      'no-undef': 'error',
      'eqeqeq': 'error',
      'no-var': 'error',
      'prefer-const': 'error',
    },
  },
  {
    files: ['confluence-turndown-rules.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: { ...browserGlobals },
    },
    rules: {
      'no-unused-vars': 'error',
      'no-undef': 'error',
      'eqeqeq': 'error',
      'no-var': 'error',
      'prefer-const': 'error',
    },
  },
  {
    files: ['background.js', 'utils.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: { ...chromeGlobal, ...swGlobals },
    },
    rules: {
      'no-unused-vars': 'error',
      'no-undef': 'error',
      'eqeqeq': 'error',
      'no-var': 'error',
      'prefer-const': 'error',
    },
  },
  {
    files: ['tests/**/*.js', 'playwright.config.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        console: 'readonly',
        process: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': 'error',
      'no-undef': 'off', // Playwright globals (test, expect) come from imports
      'eqeqeq': 'error',
      'no-var': 'error',
      'prefer-const': 'error',
    },
  },
];
