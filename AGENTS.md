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

Agents must use the Content MCP for all changes inside `static_content/` and
must inspect desktop and phone previews through the Preview MCP before publishing.
For any engine or site-code change that can affect rendered pages, agents must
also run those desktop and phone Preview MCP checks before handoff or publishing.
