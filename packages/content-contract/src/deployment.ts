import fs from "node:fs/promises";
import path from "node:path";
import { contentDir, listPosts } from "./index.js";
import { hash, workingRevision, readManagedFile, fileManifest } from "./lifecycle.js";

export interface DeploymentInput {
  version: 1; publicationId: string; engine: { repository: string; commit: string };
  files: Record<string, string>; articleRevisions: Record<string, string>;
  articleFiles: Record<string, string>; articleAssets: Record<string, Record<string, string>>;
  buildEnvironment: Record<string, string>; expectedTree: Record<string, string>;
}
export async function readDeploymentInput(dir = contentDir()): Promise<DeploymentInput | undefined> {
  try {
    const input = JSON.parse(await fs.readFile(path.join(dir, ".agentic-publication.json"), "utf8"));
    if (input.version !== 1) throw new Error("Unsupported publication manifest version.");
    return input;
  } catch (error: any) { if (error.code !== "ENOENT") throw error; return undefined; }
}
export async function renderedRevision(slug: string, dir = contentDir()) {
  const input = await readDeploymentInput(dir);
  if (input?.articleRevisions[slug] && input.articleFiles?.[slug] === hash(await readManagedFile(dir, `posts/${slug}.md`))) {
    let matches = true;
    for (const [filename, digest] of Object.entries(input.articleAssets?.[slug] || {})) {
      if (hash(await readManagedFile(dir, filename)) !== digest) matches = false;
    }
    if (matches) return input.articleRevisions[slug];
  }
  return (await workingRevision(dir, slug)).revisionId;
}
export async function buildPublicationManifest(dir = contentDir(), engineCommit = process.env.BLOG_ENGINE_COMMIT || "local", localPreview = process.env.BLOG_PREVIEW_LOCAL === "1") {
  const input = await readDeploymentInput(dir);
  if (input && !localPreview) {
    if (engineCommit !== input.engine.commit) throw new Error("Deployment engine pin differs from the approved preview. Restage and approve with the configured pin.");
    for (const key of new Set(["PUBLIC_CLOUDFLARE_WEB_ANALYTICS_TOKEN", ...Object.keys(input.buildEnvironment || {})])) {
      if ((process.env[key] || "") !== (input.buildEnvironment?.[key] || "")) throw new Error(`Deployment build environment changed: ${key}. Restage and approve.`);
    }
    for (const [filename, digest] of Object.entries(input.files)) if (hash(await readManagedFile(dir, filename)) !== digest) throw new Error(`Publication input changed: ${filename}`);
    if (JSON.stringify(await fileManifest(dir, [".git", ".agentic-publication.json"])) !== JSON.stringify(input.expectedTree)) throw new Error("Publication production context differs from the approved snapshot.");
  }
  const articleRevisions: Record<string, string> = {};
  for (const post of await listPosts(dir, localPreview)) articleRevisions[post.slug] = await renderedRevision(post.slug, dir);
  return { version: 1, publicationId: input?.publicationId || null, engine: input?.engine || { repository: "local", commit: engineCommit }, articleRevisions, files: input?.files || {} };
}
