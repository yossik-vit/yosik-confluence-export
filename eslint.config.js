const chromeGlobal = { chrome: 'readonly' };
const browserGlobals = {
  document: 'readonly',
  window: 'readonly',
  URL: 'readonly',
  Blob: 'readonly',
  fetch: 'readonly',
  console: 'readonly',
};
const swGlobals = {
  importScripts: 'readonly',
  TurndownService: 'readonly',
  turndownPluginGfm: 'readonly',
  JSZip: 'readonly',
  fetch: 'readonly',
  URL: 'readonly',
  console: 'readonly',
  Promise: 'readonly',
  Map: 'readonly',
  Set: 'readonly',
  // from utils.js (loaded via importScripts)
  pageToFilename: 'readonly',
  pageToFolderName: 'readonly',
  buildPageIndex: 'readonly',
};

export default [
  {
    ignores: ['vendor/**', 'node_modules/**'],
  },
  {
    files: ['popup.js', 'offscreen.js'],
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
    files: ['tests/**/*.test.js'],
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
      'no-undef': 'error',
      'eqeqeq': 'error',
      'no-var': 'error',
      'prefer-const': 'error',
    },
  },
];
