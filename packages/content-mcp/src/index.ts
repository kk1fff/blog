import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { allTags, contentDir, deletePost, getPost, githubPagesWorkflow, listPosts, readSettings, searchPosts, slugify, writePost, writeSettings, articleLifecycle, pendingLifecycle, isPendingArticle, readLifecycle, mutateLifecycle, stageArticle, approveArticle, readManagedFile, safePath, writeManagedFile, withContentLock } from "@agentic-blog/content-contract";
import { githubPages, publish, refreshPublication } from "./publishing.js";

const exec = promisify(execFile);
const dir = contentDir();
const text = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });

async function git(args: string[]) {
  const { stdout, stderr } = await exec("git", args, { cwd: dir });
  return `${stdout}${stderr}`.trim();
}
async function gitStatus() {
  try { return await git(["status", "--short", "--branch"]); }
  catch (error: any) { return error.stderr || error.message; }
}
async function ensureRepo() {
  try { await git(["rev-parse", "--is-inside-work-tree"]); }
  catch { throw new Error("static_content is not a Git repository. Run the setup skill first."); }
}
const server = new McpServer({ name: "agentic-blog-content", version: "0.3.0" }, { instructions: "Articles have draft/published availability and separate publishing progress. Use list_posts(pendingOnly=true) to resume unfinished work. Stage an article, inspect render_page screenshots at desktop and phone, present its revision for review, and call approve_article only after explicit user approval. commit_and_publish accepts the reviewed stagedRevisionId and returns a publication ID; use blog_status(publicationId,refresh=true) until verified live. Edits require fresh staging, preview, and approval." });

const articleStatus = z.enum(["draft", "published"]);
const publishingStatus = z.enum(["idle", "staged", "awaiting_review", "ready_to_publish", "publishing", "awaiting_merge", "succeeded", "failed"]);
server.tool("blog_status", "Read settings, Git status, pending article lifecycle, and publication progress. Refresh queries reconcile external deployment state without submitting new work.", { publicationId: z.string().optional(), refresh: z.boolean().default(false) }, async ({ publicationId, refresh }) => {
  if (refresh) {
    const state = await readLifecycle(dir);
    const ids = publicationId ? [publicationId] : Object.values(state.publications).filter(item => ["publishing", "awaiting_merge"].includes(item.status)).map(item => item.id);
    for (const id of ids) await refreshPublication(dir, id);
  }
  const articles = await pendingLifecycle(dir);
  const state = await readLifecycle(dir);
  if (publicationId && !state.publications[publicationId]) throw new Error("Publication was not found.");
  const counts: Record<string, number> = { draft: 0, published: 0 };
  const publishingCounts: Record<string, number> = {};
  for (const article of articles) {
    counts[article.status]++;
    publishingCounts[article.publishing.status] = (publishingCounts[article.publishing.status] || 0) + 1;
  }
  return text({ contentDir: dir, settings: await readSettings(dir), git: await gitStatus(), articleCounts: counts, publishingCounts, pendingArticles: articles.filter(isPendingArticle), publications: Object.values(state.publications), publication: publicationId ? state.publications[publicationId] : undefined });
});
server.tool("list_posts", "List draft/published articles with separate publishing progress. pendingOnly includes drafts, unpublished changes, and unfinished publication operations.", { includeDrafts: z.boolean().optional(), pendingOnly: z.boolean().optional(), status: articleStatus.optional(), publishingStatus: publishingStatus.optional() }, async ({ includeDrafts, pendingOnly, status, publishingStatus }) => {
  const lifecycle = await pendingLifecycle(dir);
  const posts = await listPosts(dir, true);
  return text(posts.map(post => {
    const record = lifecycle.find(item => item.slug === post.slug)!;
    return { ...post, status: record.status, hasPendingChanges: record.hasPendingChanges, publishing: record.publishing, lifecycle: record };
  }).filter(post => (includeDrafts || pendingOnly || Boolean(status) || Boolean(publishingStatus) || post.status === "published") && (!pendingOnly || isPendingArticle(post.lifecycle)) && (!status || post.status === status) && (!publishingStatus || post.publishing.status === publishingStatus)));
});
server.tool("get_post", "Read one post by its slug.", { slug: z.string() }, async ({ slug }) => {
  const post = await getPost(slug, dir); if (!post) throw new Error(`Post '${slug}' was not found.`); const lifecycle = await articleLifecycle(dir, post.slug); return text({ ...post, status: lifecycle.status, hasPendingChanges: lifecycle.hasPendingChanges, publishing: lifecycle.publishing, lifecycle });
});
server.tool("search_posts", "Search post titles, descriptions, tags, and bodies.", { query: z.string() }, async ({ query }) => text(searchPosts(await listPosts(dir, true), query)));
server.tool("list_tags", "List all post tags.", {}, async () => text(allTags(await listPosts(dir, true))));
server.tool("get_site_settings", "Read the managed blog settings.", {}, async () => text(await readSettings(dir)));

server.tool("create_post", "Create a Markdown post using managed frontmatter and a slug.", {
  title: z.string().min(1), slug: z.string().optional(), description: z.string().optional(), tags: z.array(z.string()).default([]), body: z.string().min(1), publishedAt: z.string().optional(), draft: z.boolean().default(true)
}, async (input) => withContentLock(dir, async () => {
  const slug = input.slug ? slugify(input.slug) : slugify(input.title);
  if (await getPost(slug, dir)) throw new Error(`Post '${slug}' already exists. Use update_post.`);
  const post = await writePost({ slug, title: input.title, description: input.description || "", tags: input.tags, body: input.body, publishedAt: input.publishedAt || new Date().toISOString(), draft: input.draft }, dir);
  const lifecycle = await articleLifecycle(dir, slug, true); return text({ ...post, status: lifecycle.status, hasPendingChanges: lifecycle.hasPendingChanges, publishing: lifecycle.publishing, lifecycle });
}));
server.tool("update_post", "Update a post. Omitted fields retain their existing values.", {
  slug: z.string(), title: z.string().optional(), description: z.string().optional(), tags: z.array(z.string()).optional(), body: z.string().optional(), publishedAt: z.string().optional(), draft: z.boolean().optional()
}, async (input) => withContentLock(dir, async () => {
  const post = await getPost(input.slug, dir); if (!post) throw new Error(`Post '${input.slug}' was not found.`);
  await articleLifecycle(dir, post.slug);
  const updated = await writePost({ ...post, ...input, slug: post.slug, tags: input.tags || post.tags, body: input.body ?? post.body, title: input.title ?? post.title, description: input.description ?? post.description, publishedAt: input.publishedAt ?? post.publishedAt, updatedAt: new Date().toISOString(), draft: input.draft ?? post.draft }, dir);
  const lifecycle = await articleLifecycle(dir, post.slug, true); return text({ ...updated, status: lifecycle.status, hasPendingChanges: lifecycle.hasPendingChanges, publishing: lifecycle.publishing, lifecycle });
}));
server.tool("delete_post", "Delete a working post only after an explicit confirmation flag; this does not delete the production article.", { slug: z.string(), confirm: z.literal(true) }, async ({ slug }) => withContentLock(dir, async () => {
  await deletePost(slug, dir);
  await mutateLifecycle(dir, async state => { delete state.articles[slugify(slug)]; });
  return text({ deleted: slugify(slug), productionUnchanged: true });
}));
server.tool("write_asset", "Write a base64 encoded asset under assets/ using a safe relative filename.", { filename: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/), base64: z.string() }, async ({ filename, base64 }) => withContentLock(dir, async () => {
  const relative = `assets/${filename}`;
  await writeManagedFile(dir, relative, Buffer.from(base64, "base64"));
  await pendingLifecycle(dir); return text({ asset: relative });
}));
server.tool("delete_asset", "Delete a managed asset only after an explicit confirmation flag.", { filename: z.string(), confirm: z.literal(true) }, async ({ filename }) => withContentLock(dir, async () => {
  await readManagedFile(dir, `assets/${filename}`); await fs.unlink(safePath(dir, `assets/${filename}`)); await pendingLifecycle(dir); return text({ deleted: filename });
}));
server.tool("set_site_settings", "Set managed site metadata, author profile, built-in theme, and public Giscus comments configuration.", { title: z.string().optional(), description: z.string().optional(), language: z.string().optional(), author: z.object({ greeting: z.string().min(1), bio: z.string().min(1), links: z.object({ github: z.string().url().optional(), linkedin: z.string().url().optional() }).optional() }).optional(), theme: z.enum(["paper", "journal", "mono"]).optional(), giscus: z.object({ repo: z.string().regex(/^[^/\\s]+\/[^/\\s]+$/), repoId: z.string().min(1), category: z.string().min(1), categoryId: z.string().min(1) }).optional() }, async (input) => withContentLock(dir, async () => {
  const settings = await readSettings(dir); settings.site = { ...settings.site, ...(input.title ? { title: input.title } : {}), ...(input.description ? { description: input.description } : {}), ...(input.language ? { language: input.language } : {}), ...(input.author ? { author: input.author } : {}) }; if (input.theme) settings.theme = input.theme; if (input.giscus) settings.comments = { giscus: input.giscus }; await writeSettings(settings, dir); return text(settings);
}));
server.tool("set_publishing_policy", "Set future publishing mode to direct push, pull request, or unset.", { mode: z.enum(["unset", "push", "pr"]), productionBranch: z.string().optional() }, async ({ mode, productionBranch }) => withContentLock(dir, async () => {
  const settings = await readSettings(dir); settings.publishing = { mode, productionBranch: productionBranch || settings.publishing.productionBranch }; await writeSettings(settings, dir); return text(settings.publishing);
}));
server.tool("configure_cloudflare", "Record a Cloudflare Pages project; credentials stay in GitHub secrets.", { projectName: z.string().min(1), productionBranch: z.string().default("main") }, async ({ projectName, productionBranch }) => withContentLock(dir, async () => {
  const settings = await readSettings(dir); settings.hosting = "cloudflare-pages"; settings.cloudflare = { projectName, productionBranch }; settings.publishing.productionBranch = productionBranch; await writeSettings(settings, dir); return text(settings.cloudflare);
}));
server.tool("configure_github_pages", "Replace the managed deployment workflow with the fixed GitHub Pages build and deploy workflow.", {
  productionBranch: z.string().regex(/^[A-Za-z0-9._/-]+$/).default("main"), confirm: z.literal(true)
}, async ({ productionBranch }) => withContentLock(dir, async () => {
  await writeManagedFile(dir, ".github/workflows/deploy.yml", githubPagesWorkflow(productionBranch));
  const settings = await readSettings(dir);
  settings.githubPages = { productionBranch };
  settings.hosting = "github-pages";
  settings.publishing.productionBranch = productionBranch;
  await writeSettings(settings, dir);
  return text({ provider: "github-pages", workflow: ".github/workflows/deploy.yml", productionBranch });
}));
server.tool("configure_remote", "Set the content repository origin remote.", { url: z.string().min(1) }, async ({ url }) => withContentLock(dir, async () => { await ensureRepo(); try { await git(["remote", "set-url", "origin", url]); } catch { await git(["remote", "add", "origin", url]); } return text({ origin: await git(["remote", "get-url", "origin"]) }); }));
server.tool("stage_article", "Capture an immutable article and asset snapshot against the production baseline and pinned engine. Does not push or deploy.", { slug: z.string(), assetPaths: z.array(z.string()).optional() }, async ({ slug, assetPaths }) => {
  await ensureRepo(); return text(await stageArticle(dir, slugify(slug), await githubPages.context(dir), assetPaths));
});
server.tool("approve_article", "Record explicit user approval from chat for the current staged revision after desktop and phone inspection.", { stagedRevisionId: z.string() }, async ({ stagedRevisionId }) => text(await approveArticle(dir, stagedRevisionId)));
server.tool("commit_and_publish", "Publish an approved stagedRevisionId or explicitly selected non-article paths; resume a failed/interrupted operation with publicationId. Returns durable progress; use blog_status to verify live publication.", { message: z.string().min(1), mode: z.enum(["push", "pr"]).optional(), stagedRevisionId: z.string().optional(), publicationId: z.string().optional(), paths: z.array(z.string()).optional() }, async input => {
  await ensureRepo(); return text(await publish(dir, input));
});

await server.connect(new StdioServerTransport());
