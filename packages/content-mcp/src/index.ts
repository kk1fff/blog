import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { allTags, contentDir, deletePost, getPost, githubPagesWorkflow, listPosts, readSettings, searchPosts, slugify, writePost, writeSettings } from "@agentic-blog/content-contract";

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
async function hasStagedChanges() {
  try { await git(["diff", "--cached", "--quiet"]); return false; }
  catch { return true; }
}

const server = new McpServer({ name: "agentic-blog-content", version: "0.1.0" });

server.tool("blog_status", "Read content repository, site settings, and Git status.", {}, async () => text({ contentDir: dir, settings: await readSettings(dir), git: await gitStatus() }));
server.tool("list_posts", "List posts in the managed content repository.", { includeDrafts: z.boolean().optional() }, async ({ includeDrafts }) => text(await listPosts(dir, includeDrafts)));
server.tool("get_post", "Read one post by its slug.", { slug: z.string() }, async ({ slug }) => {
  const post = await getPost(slug, dir); if (!post) throw new Error(`Post '${slug}' was not found.`); return text(post);
});
server.tool("search_posts", "Search post titles, descriptions, tags, and bodies.", { query: z.string() }, async ({ query }) => text(searchPosts(await listPosts(dir, true), query)));
server.tool("list_tags", "List all post tags.", {}, async () => text(allTags(await listPosts(dir, true))));
server.tool("get_site_settings", "Read the managed blog settings.", {}, async () => text(await readSettings(dir)));

server.tool("create_post", "Create a Markdown post using managed frontmatter and a slug.", {
  title: z.string().min(1), slug: z.string().optional(), description: z.string().optional(), tags: z.array(z.string()).default([]), body: z.string().min(1), publishedAt: z.string().optional(), draft: z.boolean().default(false)
}, async (input) => {
  const slug = input.slug ? slugify(input.slug) : slugify(input.title);
  if (await getPost(slug, dir)) throw new Error(`Post '${slug}' already exists. Use update_post.`);
  return text(await writePost({ slug, title: input.title, description: input.description || "", tags: input.tags, body: input.body, publishedAt: input.publishedAt || new Date().toISOString(), draft: input.draft }, dir));
});
server.tool("update_post", "Update a post. Omitted fields retain their existing values.", {
  slug: z.string(), title: z.string().optional(), description: z.string().optional(), tags: z.array(z.string()).optional(), body: z.string().optional(), publishedAt: z.string().optional(), draft: z.boolean().optional()
}, async (input) => {
  const post = await getPost(input.slug, dir); if (!post) throw new Error(`Post '${input.slug}' was not found.`);
  return text(await writePost({ ...post, ...input, slug: post.slug, tags: input.tags || post.tags, body: input.body ?? post.body, title: input.title ?? post.title, description: input.description ?? post.description, publishedAt: input.publishedAt ?? post.publishedAt, updatedAt: new Date().toISOString(), draft: input.draft ?? post.draft }, dir));
});
server.tool("delete_post", "Delete a post only after an explicit confirmation flag.", { slug: z.string(), confirm: z.literal(true) }, async ({ slug }) => { await deletePost(slug, dir); return text({ deleted: slugify(slug) }); });
server.tool("write_asset", "Write a base64 encoded asset under assets/ using a safe relative filename.", { filename: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/), base64: z.string() }, async ({ filename, base64 }) => {
  const target = path.resolve(dir, "assets", filename); const root = path.resolve(dir, "assets") + path.sep;
  if (!target.startsWith(root)) throw new Error("Asset path must stay inside assets/.");
  await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, Buffer.from(base64, "base64")); return text({ asset: path.relative(dir, target) });
});
server.tool("delete_asset", "Delete a managed asset only after an explicit confirmation flag.", { filename: z.string(), confirm: z.literal(true) }, async ({ filename }) => {
  const target = path.resolve(dir, "assets", filename); if (!target.startsWith(path.resolve(dir, "assets") + path.sep)) throw new Error("Asset path must stay inside assets/."); await fs.unlink(target); return text({ deleted: filename });
});
server.tool("set_site_settings", "Set managed site metadata and a built-in theme.", { title: z.string().optional(), description: z.string().optional(), language: z.string().optional(), theme: z.enum(["paper", "journal", "mono"]).optional() }, async (input) => {
  const settings = await readSettings(dir); settings.site = { ...settings.site, ...(input.title ? { title: input.title } : {}), ...(input.description ? { description: input.description } : {}), ...(input.language ? { language: input.language } : {}) }; if (input.theme) settings.theme = input.theme; await writeSettings(settings, dir); return text(settings);
});
server.tool("set_publishing_policy", "Set future publishing mode to direct push, pull request, or unset.", { mode: z.enum(["unset", "push", "pr"]), productionBranch: z.string().optional() }, async ({ mode, productionBranch }) => {
  const settings = await readSettings(dir); settings.publishing = { mode, productionBranch: productionBranch || settings.publishing.productionBranch }; await writeSettings(settings, dir); return text(settings.publishing);
});
server.tool("configure_cloudflare", "Record a Cloudflare Pages project; credentials stay in GitHub secrets.", { projectName: z.string().min(1), productionBranch: z.string().default("main") }, async ({ projectName, productionBranch }) => {
  const settings = await readSettings(dir); settings.cloudflare = { projectName, productionBranch }; settings.publishing.productionBranch = productionBranch; await writeSettings(settings, dir); return text(settings.cloudflare);
});
server.tool("configure_github_pages", "Replace the managed deployment workflow with the fixed GitHub Pages build and deploy workflow.", {
  productionBranch: z.string().regex(/^[A-Za-z0-9._/-]+$/).default("main"), confirm: z.literal(true)
}, async ({ productionBranch }) => {
  const workflowDir = path.join(dir, ".github", "workflows");
  await fs.mkdir(workflowDir, { recursive: true });
  await fs.writeFile(path.join(workflowDir, "deploy.yml"), githubPagesWorkflow(productionBranch), "utf8");
  const settings = await readSettings(dir);
  settings.githubPages = { productionBranch };
  settings.publishing.productionBranch = productionBranch;
  await writeSettings(settings, dir);
  return text({ provider: "github-pages", workflow: ".github/workflows/deploy.yml", productionBranch });
});
server.tool("configure_remote", "Set the content repository origin remote.", { url: z.string().min(1) }, async ({ url }) => { await ensureRepo(); try { await git(["remote", "set-url", "origin", url]); } catch { await git(["remote", "add", "origin", url]); } return text({ origin: await git(["remote", "get-url", "origin"]) }); });
server.tool("commit_and_publish", "Commit changes and publish with the configured direct-push or PR policy.", { message: z.string().min(1), mode: z.enum(["push", "pr"]).optional() }, async ({ message, mode }) => {
  await ensureRepo(); const settings = await readSettings(dir); const delivery = mode || settings.publishing.mode; if (delivery === "unset") throw new Error("Publishing policy is unset. Ask the user whether they prefer push or pr, then call set_publishing_policy.");
  const branch = delivery === "pr" ? `agent/${new Date().toISOString().replace(/[:.]/g, "-")}` : settings.publishing.productionBranch;
  await git(["pull", "--rebase", "--autostash", "origin", settings.publishing.productionBranch]);
  if (delivery === "pr") await git(["switch", "-c", branch]);
  await git(["add", "-A"]); if (await hasStagedChanges()) await git(["commit", "-m", message]);
  if (delivery === "push") { await git(["push", "origin", settings.publishing.productionBranch]); return text({ mode: "push", branch: settings.publishing.productionBranch }); }
  await git(["push", "-u", "origin", branch]); const result = await exec("gh", ["pr", "create", "--fill", "--base", settings.publishing.productionBranch], { cwd: dir }); return text({ mode: "pr", branch, url: result.stdout.trim() });
});

await server.connect(new StdioServerTransport());
