import fs from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import { parse, stringify } from "yaml";

export type DeliveryMode = "unset" | "push" | "pr";
export type ThemeId = "paper" | "journal" | "mono";

export interface BlogSettings {
  site: { title: string; description: string; language: string; baseUrl?: string };
  theme: ThemeId;
  engine?: { repository: string; commit: string };
  publishing: { mode: DeliveryMode; productionBranch: string };
  cloudflare?: { projectName: string; productionBranch: string };
  githubPages?: { productionBranch: string };
}

export interface Post {
  slug: string;
  title: string;
  description: string;
  tags: string[];
  publishedAt: string;
  updatedAt?: string;
  draft: boolean;
  body: string;
  path: string;
}

const defaultSettings: BlogSettings = {
  site: { title: "My Agentic Blog", description: "A blog maintained with an agent.", language: "en" },
  theme: "paper",
  publishing: { mode: "unset", productionBranch: "main" }
};

export function contentDir(value = process.env.BLOG_CONTENT_DIR): string {
  return path.resolve(value || path.join(process.cwd(), "static_content"));
}

export function slugify(value: string): string {
  const slug = value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!slug) throw new Error("Title must contain at least one letter or number.");
  return slug;
}

export function normalizeTags(tags: unknown): string[] {
  const source = Array.isArray(tags) ? tags : typeof tags === "string" ? tags.split(",") : [];
  return [...new Set(source.map((tag) => slugify(String(tag))).filter(Boolean))];
}

export async function readSettings(dir = contentDir()): Promise<BlogSettings> {
  const file = path.join(dir, "blog.yaml");
  try {
    const parsed = parse(await fs.readFile(file, "utf8")) as Partial<BlogSettings>;
    return {
      ...defaultSettings,
      ...parsed,
      site: { ...defaultSettings.site, ...parsed.site },
      publishing: { ...defaultSettings.publishing, ...parsed.publishing }
    };
  } catch (error: any) {
    if (error.code === "ENOENT") return structuredClone(defaultSettings);
    throw error;
  }
}

export async function writeSettings(settings: BlogSettings, dir = contentDir()): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "blog.yaml"), stringify(settings), "utf8");
}

export function postFromFile(file: string, raw: string): Post {
  const parsed = matter(raw);
  const slug = path.basename(file, ".md");
  const title = String(parsed.data.title || "").trim();
  const dateValue = (value: unknown) => value instanceof Date ? value.toISOString() : String(value || "");
  const publishedAt = dateValue(parsed.data.publishedAt);
  if (!title || !publishedAt) throw new Error(`${file} requires title and publishedAt frontmatter.`);
  return {
    slug,
    title,
    description: String(parsed.data.description || excerpt(parsed.content)),
    tags: normalizeTags(parsed.data.tags),
    publishedAt,
    updatedAt: parsed.data.updatedAt ? dateValue(parsed.data.updatedAt) : undefined,
    draft: Boolean(parsed.data.draft),
    body: parsed.content.trim(),
    path: file
  };
}

export async function listPosts(dir = contentDir(), includeDrafts = false): Promise<Post[]> {
  const postsDir = path.join(dir, "posts");
  try {
    const files = (await fs.readdir(postsDir)).filter((file) => file.endsWith(".md"));
    const posts = await Promise.all(files.map(async (file) => postFromFile(path.join(postsDir, file), await fs.readFile(path.join(postsDir, file), "utf8"))));
    return posts.filter((post) => includeDrafts || !post.draft).sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  } catch (error: any) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

export async function getPost(slug: string, dir = contentDir()): Promise<Post | undefined> {
  const file = path.join(dir, "posts", `${slugify(slug)}.md`);
  try { return postFromFile(file, await fs.readFile(file, "utf8")); }
  catch (error: any) { if (error.code === "ENOENT") return undefined; throw error; }
}

export async function writePost(input: Omit<Post, "path">, dir = contentDir()): Promise<Post> {
  const slug = slugify(input.slug || input.title);
  const file = path.join(dir, "posts", `${slug}.md`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const data = {
    title: input.title,
    description: input.description || excerpt(input.body),
    tags: normalizeTags(input.tags),
    publishedAt: input.publishedAt,
    ...(input.updatedAt ? { updatedAt: input.updatedAt } : {}),
    draft: Boolean(input.draft)
  };
  await fs.writeFile(file, matter.stringify(`${input.body.trim()}\n`, data), "utf8");
  return (await getPost(slug, dir))!;
}

export async function deletePost(slug: string, dir = contentDir()): Promise<void> {
  await fs.unlink(path.join(dir, "posts", `${slugify(slug)}.md`));
}

export function excerpt(markdown: string, length = 180): string {
  const plain = markdown.replace(/```[\s\S]*?```/g, "").replace(/[#>*_`\[\]()]/g, "").replace(/\s+/g, " ").trim();
  return plain.length > length ? `${plain.slice(0, length - 1).trimEnd()}…` : plain;
}

export function allTags(posts: Post[]): string[] { return [...new Set(posts.flatMap((post) => post.tags))].sort(); }

export function searchPosts(posts: Post[], query: string): Post[] {
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  return posts.filter((post) => terms.every((term) => `${post.title} ${post.description} ${post.tags.join(" ")} ${post.body}`.toLowerCase().includes(term)));
}

export function githubPagesWorkflow(productionBranch: string): string {
  return `name: Deploy blog to GitHub Pages

on:
  push:
    branches: ["${productionBranch}"]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: "pages"
  cancel-in-progress: false

jobs:
  build:
    runs-on: ubuntu-latest
    env:
      ENGINE_REPOSITORY: \${{ vars.BLOG_ENGINE_REPOSITORY }}
      ENGINE_COMMIT: \${{ vars.BLOG_ENGINE_COMMIT }}
    steps:
      - uses: actions/checkout@v4
        with:
          path: content
      - uses: actions/configure-pages@v5
      - name: Check out pinned engine
        run: |
          test -n "$ENGINE_REPOSITORY" && test -n "$ENGINE_COMMIT"
          git clone "$ENGINE_REPOSITORY" engine
          git -C engine checkout "$ENGINE_COMMIT"
      - name: Build static site
        working-directory: engine
        env:
          BLOG_CONTENT_DIR: \${{ github.workspace }}/content
          BLOG_OUTPUT_DIR: \${{ github.workspace }}/engine/.agentic-blog/github-pages-dist
        run: |
          npm ci
          npm run build
      - name: Upload GitHub Pages artifact
        uses: actions/upload-pages-artifact@v4
        with:
          path: engine/.agentic-blog/github-pages-dist

  deploy:
    environment:
      name: github-pages
      url: \${{ steps.deployment.outputs.page_url }}
    runs-on: ubuntu-latest
    needs: build
    steps:
      - name: Deploy to GitHub Pages
        id: deployment
        uses: actions/deploy-pages@v4
`;
}
