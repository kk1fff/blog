---
name: agentic-blog-content
description: Create, update, review, and publish posts for the configured agentic static blog using its Content and Preview MCP servers.
---

# Agentic Blog Content

Use Content MCP for every read and mutation in `static_content/`; never edit its
files directly. The complete architecture, interfaces, and recovery behavior are
in [the article workflow](../../docs/article-workflow.md).

1. Resume with `blog_status` and `list_posts({pendingOnly: true})`. Read relevant
   posts/settings through Content MCP. `get_post` returns working/live revisions,
   draft/published availability, pending changes, separate publishing progress,
   and the next required action. Published articles stay published during edits.
2. Create/update posts, assets, tags, theme settings, and publishing policy only
   through Content MCP. New posts default to drafts. Reference managed assets as
   `/assets/<filename>`. Updates preserve article identity and URL.
3. Call `stage_article({slug, assetPaths?})` and retain its `stagedRevisionId`.
   Staging freezes the article, dependencies, production baseline, configuration,
   and pinned engine. It never changes the working draft flag or deploys content.
   Supply extra managed asset paths for dependencies not discoverable in markup.
4. Call `open_preview` for the snapshot. Return the complete clickable browser
   URLs, Tailscale first, and the revision identifier. Keep the listener running
   while the user reviews and the conversation continues. Use `preview_status`,
   `close_preview`, and `stop_preview_server` to manage listeners. Saved builds
   survive MCP shutdown and can be reopened; listeners do not survive shutdown.
5. For every new/updated article, call `render_page` with that `stagedRevisionId`
   for both `desktop` and `phone`, using its article route. Inspect returned
   screenshots for content, layout, navigation, assets, and table-of-contents
   issues. For site/engine work, omit the revision and render every affected
   route in both viewports.
6. Present a chat review before publishing. Identify the staged revision;
   summarize title, description, tags, and changes, including full wording or a
   clear patch where needed. For diagrams, include readable source or a concise
   node/connection description and alt text. Browser screenshots alone are not
   a wording/diagram review.
7. Feedback creates a new revision. Repeat staging, viewport checks, and review.
   After the user explicitly approves the current reviewed revision in chat,
   call `approve_article`. An edit request or initial request to publish does not
   substitute for reviewing the current version. Do not approve or publish a
   changed/stale revision.
8. If publishing policy is unset, ask whether the user wants direct push or a PR
   and persist the choice with `set_publishing_policy`. Otherwise use the saved
   policy without asking again. After review approval, call
   `commit_and_publish({stagedRevisionId, message})`. The provider-specific actions
   happen inside Content MCP; do not replace them with ad hoc Git/deploy commands.
9. Retain the returned `publicationId`. Refresh with
   `blog_status({publicationId, refresh: true})` until the selected publication
   is `succeeded` after live verification. A push is not live verification;
   a PR waits for merge. Continue the conversation between
   bounded checks. Report workflow/PR links and failures. Resume interrupted or
   retryable operations with `commit_and_publish({publicationId, message})`.
10. For deletions, obtain clear user intent and pass the confirmation flag.
    Deleting a working post does not delete the public article. Production
    article deletion is outside this lifecycle publisher's first version.

## Local workspace previews and status

`open_preview()` builds the current workspace with all drafts and published
articles visible in navigation, article routes, tags, and search. Use its
`previewId` with `render_page`, `preview_status`, or `close_preview`. Reopen after
edits for an updated build. Workspace screenshots do not satisfy staged approval.

Article status is only `draft` or `published`; use `hasPendingChanges`,
`publishing.status`, and `nextAction` to resume work. Filter `list_posts` using
`status` for availability or `publishingStatus` for execution. `blog_status`
returns separate article and publishing counts. Legacy live verification may be
`unknown`; it is not a third article status. Frontmatter's draft flag is build
metadata and does not publish or unpublish an article.

## Site settings and setup publication

Review settings/assets/workflow changes in chat and inspect affected desktop and
phone pages before publishing. Use `commit_and_publish({paths, message})` with
exact non-article paths. Message-only calls and implicit inclusion of all pending
changes are disabled. Article Markdown and article assets require a staged
revision; they cannot bypass review through `paths`.

## Coupled engine and content deployments

For engine/layout changes on GitHub Pages:

1. Build and validate the engine; inspect desktop and phone previews. Obtain
   approval of the concrete reviewed rollout before publishing it.
2. Push the engine, record its pushed SHA, and set the content repository's
   `BLOG_ENGINE_COMMIT` variable to that SHA. Never pin an unpushed commit.
3. Reconnect MCP clients when tool definitions change. Regenerate a legacy
   managed workflow through Content MCP `configure_github_pages` so it passes
   the engine pin to the build.
4. Review and publish explicit non-article content changes through Content MCP,
   then monitor `blog_status` until successful live verification.
5. Article previews use the configured engine pin. If the pin or production
   baseline changes, restage, inspect, and obtain fresh article approval.

GitHub Pages remains the default host. Cloudflare configuration is retained but
its new lifecycle publication implementation is not available yet.
