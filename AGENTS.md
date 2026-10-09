# Agentic Blog

## First use

When the blog has not been configured, read and follow
[`skills/agentic-blog-setup/SKILL.md`](skills/agentic-blog-setup/SKILL.md).
This local skill is the bootstrap path: do this even when `$agentic-blog-setup`
is not yet available in Codex's global skill picker. A user can simply say
"set up my blog"; do not ask them to install or invoke a skill first.

Run the setup skill's local dependency and MCP-registration steps. Once those
finish, `$agentic-blog-setup` and `$agentic-blog-content` become available as
convenience shortcuts after Codex restarts.

## Deployment default

GitHub Pages is the primary production host. Configure it through the Content
MCP and preserve its pinned-engine workflow. Use Cloudflare Pages only when a
user explicitly asks to host there. Cloudflare Web Analytics is compatible
with GitHub Pages and does not change the hosting provider.

## Ongoing use

For routine content work, read and follow
[`skills/agentic-blog-content/SKILL.md`](skills/agentic-blog-content/SKILL.md).

For a blog favicon, compact logo, or header brand mark, read and follow
[`skills/agentic-blog-icon-design/SKILL.md`](skills/agentic-blog-icon-design/SKILL.md).

Agents must use the Content MCP for all reads and changes inside `static_content/` and
must inspect desktop and phone previews through the Preview MCP before publishing.
For any engine or site-code change that can affect rendered pages, agents must
also run those desktop and phone Preview MCP checks before handoff or publishing.

## Article status and local previews

Article `status` is only `draft` or `published`. Drafts appear in the local
workspace preview and are excluded from production. Published articles appear
in both; editing one keeps it published while its previous public revision stays
live. Use `hasPendingChanges`, `publishing.status`, and `nextAction` to find and
resume work. Never infer completion from article status alone.

Use `open_preview()` for the current workspace including drafts. Manage and
render it using its returned `previewId`. Reopen after edits to build an updated
workspace preview. Article approval requires checks of the fixed staged revision,
not workspace screenshots. Legacy verification may be `unknown`; it is metadata,
not an additional article status. Changing frontmatter's draft flag does not
publish or unpublish an article.

## Required article publishing flow

Follow [the article workflow](docs/article-workflow.md) and the content skill.
Use the existing Content and Preview MCP tools to carry out this flow:

1. Start or resume with `blog_status` and `list_posts({pendingOnly: true})`.
   Use `get_post` to inspect each relevant article's availability, pending changes,
   publishing progress, working/live revisions, and next required action.
2. Create or update articles and managed assets through Content MCP. Call
   `stage_article({slug, assetPaths?})` and retain its `stagedRevisionId`.
   Staging freezes the version to review; do not change the working draft flag
   just to make an article previewable.
3. Call `open_preview` for that staged revision. Give the user the revision ID
   and complete clickable browser addresses, with Tailscale addresses first.
   Keep the preview running while the conversation continues. Use
   `preview_status`, `close_preview`, and `stop_preview_server` to manage it.
   After an MCP shutdown, reopen the saved revision to obtain fresh URLs.
4. Call `render_page` for the same `stagedRevisionId` and article route in both
   `desktop` and `phone` viewports. Inspect both screenshots for content,
   layout, navigation, assets, and table-of-contents issues.
5. Present the staged revision for review in chat: title, description, tags,
   changes, and full wording or a clear patch as needed. Include readable
   diagram source or a node/connection description and alt text for diagrams.
   Browser screenshots alone do not complete this review.
6. After explicit user approval of that reviewed revision, call
   `approve_article`. Feedback or edits require a new staged revision, both
   viewport checks, and fresh approval. An initial request to publish does not
   substitute for approval of the concrete reviewed article.
7. If publishing policy is unset, ask whether to publish by direct push or PR
   and save the choice with `set_publishing_policy`. Otherwise use the saved
   policy without asking again. Call
   `commit_and_publish({stagedRevisionId, message})`; provider-specific Git and
   deployment actions belong inside Content MCP.
8. Retain the returned `publicationId` and refresh
   `blog_status({publicationId, refresh: true})` until the selected publication
   reports `succeeded` after live verification. A successful push is not proof
   that the article is live; PR publications wait for merge. Report workflow/PR
   links and failures, and
   continue the conversation between bounded status checks. Resume interrupted
   or retryable publication with
   `commit_and_publish({publicationId, message})`.

Do not bypass article review with shell Git/deployment commands or explicit-path
publication. For setup and site settings, review the concrete changes and any
affected desktop and phone pages, then use `commit_and_publish({paths, message})`
with exact non-article paths. Never implicitly include all pending changes.

When required lifecycle tools are unavailable, reconnect MCP clients or update
the engine deployment as described in the content skill before continuing.
Do not fall back to an older unrestricted publishing flow.
