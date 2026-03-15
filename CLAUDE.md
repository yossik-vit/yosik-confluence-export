# Project: Conf Export Ext

## Stack
- **Language:** Vanilla JavaScript (no frameworks)
- **Bundling:** JSZip — used to package exported files into a `.zip` download
- **Markdown conversion:** Turndown — converts HTML to Markdown
- **API:** Confluence REST API — source of page content and metadata

## Conventions
- No build step, no transpilation. Plain `.js` files loaded directly by the extension.
- Keep dependencies as vendored scripts in `vendor/` (loaded via `manifest.json`), not via npm.

## Standing Orders
- Update this file when learning something new about the project.
- Update README.md when relevant changes happen.
- Commit early, commit often — after completing a task (once checks pass).

## Programming Rules
- **Agile delivery:** minimal vertical slices, working end-to-end before expanding.
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
- Follow the **test automation pyramid** (Martin Fowler): always test at the deepest possible layer first.
  - **Unit tests** (Node.js, no browser): pure functions — filename sanitization, path computation, index building, link rewriting. Run with `node --test`.
  - **Integration tests** (Node.js, fetch mocked): functions that call the Confluence REST API — verify correct URLs, pagination, error handling.
  - **Manual / E2E** (Chrome, real Confluence): only for things that cannot be automated (visual rendering, actual zip download, Obsidian link navigation). Automate as much of this layer as possible; document what remains manual and why.
- Automate every manual testing step that can be automated (e.g. zip structure validation, Markdown content checks, link rewriting correctness).
- Run linting together with tests on every check (`npm test` must invoke both).

## Linting
- Use ESLint with a config committed to the repo.
- `npm test` runs lint + unit tests together.
- Fix all lint errors before committing; warnings must not increase.

## Output
Brief but precise, no bloat. Bullet points where appropriate.
