---
name: agentic-blog-content
description: Create, update, review, and publish posts for the configured agentic static blog using its Content and Preview MCP servers.
---

# Agentic Blog Content

Use Content MCP for every read and mutation in `static_content/`; never edit its files directly.

1. Read site settings and relevant posts through Content MCP before making changes.
2. Create or update posts, assets, tags, theme settings, and publishing policy only through Content MCP. Reference a managed asset in Markdown as `/assets/<filename>`.
3. Render every changed route with Preview MCP in both `desktop` and `phone` viewports. Inspect the returned screenshots for content, layout, navigation, and table-of-contents issues.
4. Before the first publish, ask whether the user wants direct push or a pull request and persist the selection with `set_publishing_policy`.
5. After visual review, use `commit_and_publish`. For deletions, obtain clear user intent and pass the required confirmation flag.
