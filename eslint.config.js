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
  // from utils.js (loaded via importScripts)
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
      globals: { ...chromeGlobal, ...browserGlobals },
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
