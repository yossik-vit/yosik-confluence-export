# Project: Conf Export Ext

## Stack
- **Language:** Vanilla JavaScript (no frameworks)
- **Bundling:** JSZip — used to package exported files into a `.zip` download
- **Markdown conversion:** Turndown — converts HTML to Markdown
- **API:** Confluence REST API — source of page content and metadata

## Conventions
- No build step, no transpilation. Plain `.js` files loaded directly by the extension.
- Runtime dependencies (JSZip, Turndown, …) are vendored in `vendor/` and loaded via `importScripts()` — not via npm.
- Dev tooling (ESLint, Playwright, …) lives in `package.json` devDependencies — npm is fine for tools that never ship in the extension.

## Standing Orders
- Update this file when learning something new about the project.
- Update README.md when relevant changes happen.
- Commit after every completed vertical slice (once checks pass).
- Before every commit, review all uncommitted files (`git status`). For each file, decide: commit it (if intentional) or delete it (if leftover/accidental). Do not leave unexplained uncommitted files behind.
- Before committing, check whether any new files or directories should be added to `.gitignore`.

## Programming Rules
- **Agile delivery:** minimal vertical slices, fully tested and working end-to-end before expanding.
- **YAGNI / KISS:** simplest solution that works.
- **Boy scout rule:** fix pre-existing issues (lint errors, broken behavior) even if not caused by current changes.
- No magic numbers — use named constants.
- No refactoring-context comments.

## Changes
Unless following the boy scout rule: only do modifications requested.

## Testing
- Every change needs appropriate test coverage — write tests as soon as the functionality is coded, not at the end.
- All tests must pass before committing.
- Always set reasonable timeouts on operations that might hang.
- Follow the **test automation pyramid** (Martin Fowler): test at the lowest layer that meaningfully covers the functionality — do not duplicate coverage at a higher layer.
  - **Unit tests** (Node.js, no browser): pure functions — filename sanitization, path computation, index building, link rewriting. Run with `npm test`.
  - **Integration tests** (Node.js, fetch mocked): only for behavior that cannot be verified at unit level — e.g. correct REST URL construction, pagination loop, 401 handling across the fetch boundary. Run with `npm test`.
  - **E2E tests** (Playwright, Chrome with extension loaded): popup UI, extension lifecycle, and flows that require a real browser context but not a live Confluence instance. Run with `npm run test:e2e`. Uses `headless: false` — Chrome extensions require it; use headless mode for everything else. Apply the **Automation in Testing** pattern: automate setup and result verification; let the human perform only steps that need a real Confluence instance. Document every remaining manual step and why it cannot be automated.
  - **Visual debugging**: when automated assertions are insufficient to diagnose a failure, take a whole-browser screenshot via macOS `screencapture` (e.g. `screencapture -x /tmp/debug.png`) or via Playwright's `page.screenshot()`, then analyse the image.
- Automate every testing step that can be automated. Steps requiring a live Confluence instance are the only acceptable residual manual steps.
- `npm test` runs lint + unit/integration tests. `npm run test:e2e` runs Playwright E2E tests. Both must pass before committing.

## Linting
- Use ESLint with a config committed to the repo.
- `npm test` runs lint + unit tests together.
- Fix all lint errors before committing; warnings must not increase.

## Output
Brief but precise, no bloat. Bullet points where appropriate.
