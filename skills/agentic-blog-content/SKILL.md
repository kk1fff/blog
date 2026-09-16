---
name: agentic-blog-content
description: Create, update, review, and publish posts for the configured agentic static blog using its Content and Preview MCP servers.
---

# Agentic Blog Content

Use Content MCP for every read and mutation in `static_content/`; never edit its files directly.

1. Read site settings and relevant posts through Content MCP before making changes.
2. Create or update posts, assets, tags, theme settings, and publishing policy only through Content MCP. Reference a managed asset in Markdown as `/assets/<filename>`.
3. Render every changed route with Preview MCP in both `desktop` and `phone` viewports. Inspect the returned screenshots for content, layout, navigation, and table-of-contents issues.
4. For every post creation or update, provide a chat review before publishing. Summarize the proposed title, description, tags, draft status, and substantive changes; include the full draft or a clear patch when the user needs to judge the wording.
5. For every new or changed diagram, include a text representation in the chat review. Use the diagram source when it is readable (such as Mermaid), otherwise provide a concise node-and-connection description and the image alt text. Do not make the user rely only on a screenshot to review a diagram.
6. Do not call `commit_and_publish` until the user explicitly approves the reviewed version in the chat. A request to create or edit a post is not approval to publish. If the user asks to publish without having reviewed the current version, show the review first and wait.
7. Before the first approved publish, ask whether the user wants direct push or a pull request and persist the selection with `set_publishing_policy`. The saved delivery policy applies only after the review approval.
8. For deletions, obtain clear user intent and pass the required confirmation flag.

## Coupled engine and content deployments

When a layout, template, or content-contract change must reach a GitHub Pages site that builds the content repository against `BLOG_ENGINE_REPOSITORY` and `BLOG_ENGINE_COMMIT`:

1. Build, commit, and push the engine/code repository first; record its pushed commit SHA.
2. Update the content repository’s `BLOG_ENGINE_COMMIT` GitHub variable to that SHA. Do not rely on a content push alone: the deployment otherwise builds the prior pinned engine.
3. Commit and publish the managed static content only after the user approves it. Then dispatch or confirm the GitHub Pages workflow uses the updated pin.
4. Wait for a successful deployment and verify the live page contains a distinctive change from the new template. If the browser still serves an old root page, check cache headers and use a versioned query string to distinguish CDN caching from a failed deployment.
