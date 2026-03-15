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
- Every change needs appropriate test coverage.
- All tests must pass before committing.
- Always set reasonable timeouts on operations that might hang.

## Output
Brief but precise, no bloat. Bullet points where appropriate.
