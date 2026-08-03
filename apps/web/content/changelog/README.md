# Changelog content

Every file in `desktop/`, `web/`, `mobile/`, or `extension/` becomes an entry on [cap.so/changelog](https://cap.so/changelog), filtered by the folder it lives in. Entries are plain markdown with a small frontmatter block, sorted by `publishedAt` (newest first).

## Adding an entry

Create an `.mdx` file in the platform folder:

- `desktop/`: numbered filenames (`101.mdx`, `102.mdx`, and so on). These are also served to the desktop app's in-app changelog via `/api/changelog`, which sorts by the numeric filename, so keep the sequence increasing. `version` is required.
- `web/`, `mobile/`, `extension/`: date-prefixed filenames (`2026-08-03-live-transcription.mdx`). `version` is optional (use it for versioned releases like the extension).

```
---
title: Live transcription on the share page
publishedAt: "2026-08-03"
version: 1.0.3
---

One short paragraph summarizing the release. This intro is always visible on the page.

## Features

- **Feature name** - What it does, written for users.

## Fixes

- **Fix name** - What changed.
```

## How entries render

- The intro (everything before the first `## ` heading) is always visible.
- Everything from the first `## ` heading on is collapsed behind "Show release notes" when it runs long, so keep the intro to a sentence or two that stands on its own.
- Entries without headings render inline when short; a long bullet list with no intro collapses behind the toggle with only the title showing.
- Content is rendered as plain markdown (not compiled MDX), matching the desktop app's in-app changelog renderer — no JSX or imports.
- The page is statically paginated (20 entries per page, `/changelog/page/2` and so on, same for platform filters). Pagination, static params, and the sitemap all derive from the content folders at build time, so adding a file is all you need to do.
