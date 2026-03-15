# Conf Export Ext

Chrome extension that exports an entire Confluence space to Markdown files, packaged as `.zip` downloads.

## Features

- Converts Confluence HTML pages to Markdown (via Turndown)
- Preserves the page hierarchy as a nested folder structure
- Downloads images and attachments into per-page subdirectories
- Rewrites internal Confluence links to relative Markdown paths
- Replaces Confluence emoticons and Twitter emojis with Unicode
- Automatically chunks large spaces into multiple zip files (50 pages each)

## Usage

1. Navigate to any page in the Confluence space you want to export.
2. Click the extension icon.
3. Click **Export Space**.
4. Zip file(s) named `<SpaceName>.zip` (or `<SpaceName>-1.zip`, `-2.zip`, etc.) will download automatically.

## Installation

1. Clone this repository.
2. Open `chrome://extensions` and enable **Developer mode**.
3. Click **Load unpacked** and select the repository folder.

## Development

```bash
npm install          # install dev tooling (ESLint, Playwright)
npm test             # lint + unit tests
npm run test:e2e     # Playwright E2E tests
```

No build step required — plain `.js` files are loaded directly by the extension.

## Author

Christian Baumann — [mail@christianbaumann.dev](mailto:mail@christianbaumann.dev) — [www.christianbaumann.dev](https://www.christianbaumann.dev)
