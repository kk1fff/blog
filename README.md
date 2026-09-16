# Agentic Static Blog

An Astro static blog whose content lives in an independently versioned `static_content/` repository. Agents use MCP servers for managed content changes and Playwright production previews.

## First use

Clone this repository, then ask Codex to run `$agentic-blog-setup`. The skill installs dependencies, creates a starter content repository, configures MCPs, and guides GitHub and Cloudflare Pages setup.

For local development after setup, use `npm run dev` with `BLOG_CONTENT_DIR` set to the content repository if it is outside the default `static_content/` directory.
