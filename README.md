# Agentic Static Blog

An Astro static blog whose content lives in an independently versioned `static_content/` repository. Agents use MCP servers for managed content changes and Playwright production previews.

## First use

Open Codex in the cloned repository and say:

```text
Set up my blog.
```

The repository's `AGENTS.md` makes this work immediately: the agent reads the
included setup skill and performs the local bootstrap steps itself. You do not
need to invoke a `$skill` before the first setup.

The agent runs these commands as part of that workflow:

```bash
npm ci
npm run setup
```

After the setup command completes, restart Codex to make `$agentic-blog-setup`
and `$agentic-blog-content` available as optional shortcuts. The setup skill
then creates or connects the content repository, configures MCPs, and guides
GitHub Pages setup. GitHub Pages is the default production host; Cloudflare
Pages is an explicit alternative, while Cloudflare Web Analytics can be used
without moving the site from GitHub Pages.

Local development includes draft articles. After setup, use `npm run dev` with `BLOG_CONTENT_DIR` set to the content repository if it is outside the default `static_content/` directory.

## Article lifecycle

Article status is `draft` or `published`. Local workspace previews show both;
production excludes drafts. Published articles retain their status during edits,
with `hasPendingChanges` and separate `publishing.status` tracking unfinished work.
Use `open_preview()` for the workspace, or pass `stagedRevisionId` to review an
immutable production candidate. Publication success is reported as `succeeded`.


The existing Content MCP now tracks working/live revisions, pending work,
reviewed snapshots, and recoverable publications. The Preview MCP serves staged
articles at clickable machine addresses (Tailscale first) and captures desktop
and phone views. Browser listeners remain available during review and end with
the MCP connection; snapshots survive restart.

Use `list_posts(pendingOnly=true)` to resume work, `stage_article` and
`render_page` to review, `approve_article` after explicit chat approval,
`commit_and_publish(stagedRevisionId=...)` to publish, and `blog_status` to
monitor deployment through live revision verification. GitHub Pages is the
first hosting implementation.

See [the architecture and tool reference](docs/article-workflow.md) for server
lifecycle, recovery, compatibility changes, and existing-installation upgrades.
Message-only publication no longer includes all pending files: setup/settings
publication requires explicit `paths`. Article publication requires a reviewed
staged revision.
