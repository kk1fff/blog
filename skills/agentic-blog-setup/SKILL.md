---
name: agentic-blog-setup
description: Guide a user through first-time setup or deployment reconfiguration of the agentic static blog in this repository.
---

# Agentic Blog Setup

Use this skill when `static_content/` is missing, the blog is not connected to GitHub Pages, or the user asks to reconfigure setup. GitHub Pages is the default production host. Use Cloudflare Pages only when the user explicitly requests it; Cloudflare Web Analytics does not require changing hosts.

1. Run `npm ci`, `npm run build`, then `npm run doctor`. Explain missing prerequisites and install only the dependencies needed for the selected setup path.
2. Run `npm run setup` to create the local starter content repository and register the MCP servers. Do not recreate `static_content/` when it already exists.
3. Ask for the site title, description, and theme; set them through the Content MCP. Ask whether a GitHub repository should be created through authenticated `gh` or connected from a URL. Configure it through the Content MCP.
4. Configure GitHub Pages through the Content MCP unless the user explicitly selects Cloudflare Pages. Set the custom domain in GitHub Pages and preserve its `CNAME` file in the content repository when one is used.
5. Set the GitHub repository variables `BLOG_ENGINE_REPOSITORY` and `BLOG_ENGINE_COMMIT`. Derive the engine repository and commit from this repository's Git remote and a commit already pushed to its remote branch; do not pin an unpushed local commit. Verify that the engine is reachable from GitHub Actions.
6. If the user enables Cloudflare Web Analytics, add its public beacon token as the `CLOUDFLARE_WEB_ANALYTICS_TOKEN` GitHub repository variable and pass it to the GitHub Pages build. Do not configure Cloudflare API credentials unless Cloudflare Pages was explicitly selected.
7. Use Preview MCP to inspect the welcome page at desktop and phone size. Commit and publish the starter content only after the user chooses direct push or PR delivery; save that policy through Content MCP.
8. Finish with `npm run doctor` and report the content remote, GitHub Pages URL, deployment mode, and MCP names. Resume from the first incomplete checkpoint if setup is run again.

For GitHub Pages, a later engine/layout change requires pushing the engine first, advancing the content repository’s `BLOG_ENGINE_COMMIT` variable to that pushed SHA, and rerunning the content deployment.

If an existing content repository has an unfamiliar structure, inspect it and ask the user what to preserve before changing it.
