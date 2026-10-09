# Article workflow

The blog uses the existing Content and Preview MCP servers. Content MCP owns
article edits, staging, approval, and publication; Preview MCP owns rendering
and browser listeners. Both use a repository-specific lifecycle store beneath
`.agentic-blog/repositories/`. This local state is ignored by Git, persists
across conversations, and should be included in workspace backups. Review state
is not synchronized between workspace machines.

## Tool inventory

Existing tools remain available. Their additions are:

| Tool | Added behavior |
| --- | --- |
| `create_post`, `update_post` | Record working revisions. New posts default to drafts. Edits invalidate approval. |
| `write_asset`, `delete_asset` | Reconcile articles affected by asset changes. |
| `list_posts` | Filter by article `status` (`draft`/`published`), `publishingStatus`, or `pendingOnly`; return availability and publishing summaries. |
| `get_post` | Return lifecycle, working/live revisions, publication reference, and next action. |
| `blog_status` | Return pending articles, separate `articleCounts` and `publishingCounts`, publication checkpoints, and deployment links; `publicationId` selects one operation and `refresh: true` reconciles remote progress. |
| `commit_and_publish` | Publish a reviewed `stagedRevisionId`, explicitly selected non-article `paths`, or resume an existing `publicationId`. Always include a commit `message`. |
| `render_page` | Add `stagedRevisionId`; record desktop/phone evidence for that article route. Omitting it previews the current workspace including drafts; `previewId` reuses an active preview. |

New Content tools:

- `stage_article({slug, assetPaths?})`: freeze a production candidate and return
  `stagedRevisionId`, route, hashes, and pinned engine provenance. `assetPaths`
  supplements dependencies automatically discovered in Markdown, reference
  definitions, HTML, SVG, and CSS.
- `approve_article({stagedRevisionId})`: record the user's explicit chat approval
  after both viewport checks. The agent must inspect the returned screenshots;
  the server cannot determine whether the user approved wording or whether a
  screenshot is visually correct.

New Preview tools:

- `open_preview({stagedRevisionId?})`: with a revision, build/reuse the pinned
  production candidate; without one, build the current workspace including all
  drafts. Return `previewId`, preview mode, and complete URLs, Tailscale first.
- `preview_status({stagedRevisionId?, previewId?})`: report current listeners and addresses.
- `close_preview({stagedRevisionId?, previewId?})`: select exactly one identifier
  to stop its listener and revoke its link.
- `stop_preview_server()`: stop all previews; retain saved builds.

There are no separate publish, article-status, pending-list, or publication-status
tools: use the existing tools above.

## Authoring and review

1. Resume with `list_posts({pendingOnly: true})` and inspect `get_post({slug})`.
2. Create or edit through Content MCP.
3. Call `stage_article`. It takes the production branch as its baseline and
   overlays only the article and required assets. The working draft flag stays
   unchanged; the snapshot's article is renderable.
4. Open the snapshot with `open_preview` and render its article route through
   `render_page` at `desktop` and `phone`. Inspect both screenshots.
5. Present the revision, title/metadata, wording or patch, preview links, and
   readable diagram source/description in chat. Continue discussing feedback.
6. Feedback creates another working revision. Repeat staging, rendering, and
   review. Approval never transfers to changed content or assets.
7. After explicit approval, call `approve_article`, then
   `commit_and_publish({stagedRevisionId, message})`.
8. Use `blog_status({publicationId, refresh: true})` until the revision is
   verified live. A successful push is still `publishing`; a PR is
   `awaiting_merge`. The agent does not automatically merge PRs.

## Article availability and publishing progress

An article has exactly two statuses: `draft` (local preview only) or `published`
(public and local preview). Editing a published article keeps it `published`;
its existing public revision remains live. `hasPendingChanges` identifies drafts
and working revisions that differ from the recorded live revision.

Review and deployment use a separate `publishing.status`: `idle`, `staged`,
`awaiting_review`, `ready_to_publish`, `publishing`, `awaiting_merge`, `succeeded`,
or `failed`. `staged` means a snapshot exists; `awaiting_review` means both
viewport screenshots have been recorded; `ready_to_publish` means that revision
is approved. Publication records finish with `succeeded` after live verification.
These execution statuses never replace article availability. `nextAction` is
calculated from progress, revision differences, and errors.

`list_posts({pendingOnly: true})` includes published articles with pending edits
or unfinished/failed execution. Filter availability with `status`; filter
execution with `publishingStatus`. `blog_status` reports `articleCounts`,
`publishingCounts`, and pending articles independently.

Legacy non-draft articles import as `published` with `liveVerification: unknown`;
verification becomes `verified` only with deployment evidence. Unknown live
revisions remain pending reconciliation. There is no `unverified` article status.
Version 1 local lifecycle state is migrated atomically to version 2, retaining
snapshots, approvals, publication identities, and recovery checkpoints. Existing
live metadata or a saved production baseline preserves public availability.

Markdown's `draft` flag remains build metadata. Changing it does not verify a
publication or unpublish an existing public article. Creating an article through
MCP always records draft availability until its first verified publication.

Local workspace previews use current working content and include all articles
in homepage, article routes, tags, and search. They are built snapshots: reopen
with `open_preview()` to see subsequent edits. They do not record staged review
evidence. Staged previews preserve the exact production candidate and exclude
unrelated local edits and drafts. Production builds explicitly disable the local
preview flag and use the reviewed production snapshot.

## Browser server lifecycle

The remote workspace machine serves each workspace build or staged snapshot on its own available port,
using all IPv4/IPv6 interfaces supported by its OS. Results include every
interface address, with Tailscale addresses first and full URLs for usable
addresses. Loopback addresses work only on the workspace machine. Link-local
addresses are listed but need interface scope and are not advertised as links.
Addresses are discovered from the machine; browser-side reachability still
requires routing to that machine and port.

The initial secret link sets a preview-specific HttpOnly cookie and redirects
to the article. Pages and assets require that cookie. Links are revoked when a
preview closes. Do not share links beyond intended reviewers.

Serving continues after a tool returns and while the conversation waits for
feedback. It ends on explicit close/stop, MCP stdin/connection closure, or
process termination. A chat reply does not itself mean the connection closed.
Closing the MCP kills its listeners; it does not delete snapshots or builds.
After restarting, use `open_preview` to reopen the same saved revision with a
current port and secret link. Previews do not auto-start on reconnect.

## Publication and recovery

GitHub Pages is the first hosting implementation. Cloudflare configuration is
preserved, but the lifecycle publisher reports that its implementation is not
available yet. The saved push/PR delivery policy remains in effect.

The publisher prepares selected bytes in an isolated checkout. It does not
switch the working branch, touch the working index, or include unrelated drafts,
settings, or files. Production context or engine-pin changes before submission
require fresh staging and approval. Overwriting an asset used by another
production article or the engine requires a new filename.

Publication checkpoints record preparation, commit, push, submission,
deployment, and verification. If a call fails or its result is lost, resume with
`commit_and_publish({publicationId, message})`; article retries may also use the
same staged revision. Retry reconciles existing commits, branches, PRs, and
workflow attempts. It does not roll back a newer remote commit. Only one active
publication may submit to a repository at a time.

Refreshing status is bounded; it reports transient errors and a retry timestamp
rather than waiting through an entire deployment. The agent can continue the
conversation between refresh calls. A deployment failure can rerun the recorded
commit. A closed PR or changed merged tree requires intervention/new review.

Publication success requires a successful managed workflow, the expected
`publication-manifest.json`, an article revision marker in live HTML, and exact
required asset bytes. The build checks its engine pin, captured build environment, selected input hashes,
and complete production content context.
Metadata identifies revisions; no private review messages or preview tokens
are copied into the published site.

## Setup, settings, and upgrade compatibility

Message-only `commit_and_publish` calls are intentionally rejected. For setup
and site settings, select exact non-article files with `paths`; for example,
`["blog.yaml", ".github/workflows/deploy.yml"]`. Include other foundational
files/assets only when they have been reviewed. Article Markdown and assets
referenced by articles must use staged article publication.

For a new repository, publish foundational settings/workflow files first, then
stage, inspect, approve, and publish the welcome article. An empty production
branch is supported for foundational publication.

For an existing installation:

1. Build and validate the new engine. Inspect affected pages at desktop and
   phone sizes through Preview MCP.
2. After approval of the engine rollout, push the engine and set the content
   repository's `BLOG_ENGINE_COMMIT` to that pushed commit. Preserve
   `BLOG_ENGINE_REPOSITORY` and the GitHub Pages provider.
3. Restart/reconnect the MCP clients to load the new tool definitions.
4. Use Content MCP `configure_github_pages` to regenerate the managed workflow,
   then review and publish its explicit paths. The new workflow passes
   `BLOG_ENGINE_COMMIT` to the build for snapshot verification.
5. Monitor the deployment through `blog_status`. Article staging uses the
   configured pushed engine; an older pin without lifecycle support is rejected.

No existing Markdown is rewritten during lifecycle import. Back up the local
lifecycle directory together with the remote workspace. Scheduling, bulk
publication, article renaming, automatic PR merging, and cross-workspace
approval synchronization are outside this version.
