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
GitHub and Cloudflare Pages setup.

For local development after setup, use `npm run dev` with `BLOG_CONTENT_DIR` set to the content repository if it is outside the default `static_content/` directory.
