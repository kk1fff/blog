import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { contentDir, getPost, listPosts, writePost, postFromFile, readSettings } from "./index.js";

const exec = promisify(execFile);
export const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export const now = () => new Date().toISOString();
export type ArticleStatus = "draft" | "published";
export type PublishingStatus = "idle" | "staged" | "awaiting_review" | "ready_to_publish" | "publishing" | "awaiting_merge" | "succeeded" | "failed";
export interface ArticleRecord {
  slug: string; revisionId: string; assetPaths: string[]; extraAssetPaths?: string[]; status: ArticleStatus;
  liveRevisionId?: string; stagedRevisionId?: string; approvedAt?: string; publicationId?: string;
  validationError?: string;
  publishing: { status: PublishingStatus; error?: string };
  hasPendingChanges: boolean; liveVerification: "unknown" | "verified"; updatedAt: string;
}
export interface StageContext {
  provider: "github-pages" | "cloudflare-pages"; repository: string; remote: string;
  productionBranch: string; baseCommit: string | null;
  engine: { repository: string; commit: string };
  buildEnvironment: Record<string, string>;
  sharedAssetPaths?: string[];
}
export interface StageRecord extends StageContext {
  id: string; slug: string; revisionId: string; assetPaths: string[];
  files: Record<string, string>; snapshotFiles: Record<string, string>; createdAt: string;
  previews: Partial<Record<"desktop" | "phone", { screenshot: string; route: string; checkedAt: string }>>;
  approvedAt?: string;
}
export interface Publication {
  id: string; stagedRevisionId?: string; slug?: string; revisionId?: string;
  context: StageContext; files: Record<string, string>; mode: "push" | "pr"; message: string;
  status: "publishing" | "awaiting_merge" | "succeeded" | "failed";
  step: "prepared" | "committed" | "pushed" | "submitted" | "deployed" | "verified";
  branch: string; commit?: string; mergeCommit?: string; prUrl?: string; prNumber?: number;
  runId?: number; runAttempt?: number; workflowUrl?: string; liveUrl?: string;
  observedAt?: string; error?: string; recoverable?: boolean; retryAfter?: string;
  liveRevisions?: Record<string, string>;
  createdAt: string; updatedAt: string;
}
export interface LifecycleState {
  version: 2; articles: Record<string, ArticleRecord>; stages: Record<string, StageRecord>;
  publications: Record<string, Publication>;
}
export function lifecycleDir(dir = contentDir(), root = process.env.AGENTIC_BLOG_ROOT || process.cwd()) {
  return path.join(path.resolve(root), ".agentic-blog", "repositories", hash(path.resolve(dir)).slice(0, 24));
}
export function safePath(root: string, relative: string) {
  if (!relative || relative.includes("\\") || relative.includes("\0") || path.isAbsolute(relative) || relative.split("/").some(part => !part || part === "." || part === ".." || part === ".git")) throw new Error(`Unsafe managed path: ${relative}`);
  const resolved = path.resolve(root, relative);
  if (!resolved.startsWith(path.resolve(root) + path.sep)) throw new Error("Path escapes managed directory.");
  return resolved;
}
export async function readManagedFile(root: string, relative: string): Promise<Buffer> {
  const target = safePath(root, relative);
  const realRoot = await fs.realpath(root);
  const real = await fs.realpath(target);
  if (!real.startsWith(realRoot + path.sep)) throw new Error(`Asset escapes managed directory: ${relative}`);
  let cursor = root;
  for (const part of relative.split("/")) {
    cursor = path.join(cursor, part);
    if ((await fs.lstat(cursor)).isSymbolicLink()) throw new Error(`Symlink is not a managed file: ${relative}`);
  }
  return fs.readFile(target);
}
export async function writeManagedFile(root: string, relative: string, bytes: string | Buffer) {
  const target = safePath(root, relative);
  await fs.mkdir(root, { recursive: true });
  let cursor = root;
  for (const part of relative.split("/").slice(0, -1)) {
    cursor = path.join(cursor, part);
    await fs.mkdir(cursor).catch((error: any) => { if (error.code !== "EEXIST") throw error; });
    const entry = await fs.lstat(cursor);
    if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error("Managed parent directories cannot be symlinks.");
  }
  const existing = await fs.lstat(target).catch((error: any) => { if (error.code !== "ENOENT") throw error; return undefined; });
  if (existing?.isSymbolicLink() || existing?.isDirectory()) throw new Error("Managed files cannot be symlinks or directories.");
  const temporary = `${target}.${randomUUID()}.tmp`;
  try { await fs.writeFile(temporary, bytes); await fs.rename(temporary, target); }
  finally { await fs.rm(temporary, { force: true }); }
}
export async function fileManifest(directory: string, excluded: string[] = []) {
  const files: Record<string, string> = {};
  async function walk(relative: string) {
    for (const entry of (await fs.readdir(path.join(directory, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = path.posix.join(relative, entry.name);
      if (excluded.includes(name)) continue;
      if (entry.isDirectory()) await walk(name);
      else if (entry.isFile()) files[name] = hash(await readManagedFile(directory, name));
      else throw new Error("Managed trees cannot contain symlinks.");
    }
  }
  await walk(""); return files;
}
export async function atomicJson(file: string, value: unknown) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { await fs.writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 }); await fs.rename(temporary, file); }
  finally { await fs.rm(temporary, { force: true }); }
}
export async function withFileLock<T>(directory: string, action: () => Promise<T>): Promise<T> {
  await fs.mkdir(path.dirname(directory), { recursive: true });
  const token = randomUUID();
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.mkdir(directory);
      await atomicJson(path.join(directory, "owner.json"), { pid: process.pid, token });
      break;
    } catch (error: any) {
      if (error.code !== "EEXIST") throw error;
      try {
        const owner = JSON.parse(await fs.readFile(path.join(directory, "owner.json"), "utf8"));
        try { process.kill(owner.pid, 0); }
        catch (probe: any) { if (probe.code === "ESRCH") { await fs.rm(directory, { recursive: true, force: true }); continue; } }
      } catch (readError: any) {
        if (readError.code !== "ENOENT") throw readError;
        const entry = await fs.stat(directory).catch(() => undefined);
        if (entry && Date.now() - entry.mtimeMs > 1000) { await fs.rm(directory, { recursive: true, force: true }); continue; }
      }
      if (attempt >= 100) throw new Error("Another MCP operation owns this repository lock. Retry after it finishes.");
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  try { return await action(); }
  finally {
    const owner = JSON.parse(await fs.readFile(path.join(directory, "owner.json"), "utf8"));
    if (owner.token === token) await fs.rm(directory, { recursive: true, force: true });
  }
}
async function loadLifecycle(dir: string): Promise<LifecycleState> {
  const file = path.join(lifecycleDir(dir), "state.json");
  let state: any;
  try { state = JSON.parse(await fs.readFile(file, "utf8")); }
  catch (error: any) {
    if (error.code !== "ENOENT") throw error;
    return { version: 2, articles: {}, stages: {}, publications: {} };
  }
  if (state.version === 2) return state;
  if (state.version !== 1) throw new Error("Unsupported article lifecycle storage version.");
  for (const publication of Object.values(state.publications) as any[]) {
    if (publication.status === "published") publication.status = "succeeded";
  }
  for (const article of Object.values(state.articles) as any[]) {
    const oldStatus = article.status;
    const verified = (Object.values(state.publications) as Publication[])
      .filter(item => item.status === "succeeded" && (item.slug === article.slug || item.liveRevisions?.[article.slug]))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    if (verified) article.liveRevisionId = verified.liveRevisions?.[article.slug] || verified.revisionId;
    let published = Boolean(article.liveRevisionId) || ["published", "unverified"].includes(oldStatus);
    if (!published) {
      const stages = Object.values(state.stages) as StageRecord[];
      const matchingStages = stages.filter(stage => stage.slug === article.slug).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const baselines = [state.stages[article.stagedRevisionId]?.baseCommit, ...matchingStages.map(stage => stage.baseCommit),
        ...stages.map(stage => stage.baseCommit), ...(Object.values(state.publications) as Publication[]).map(item => item.context.baseCommit)];
      const settings = await readSettings(dir);
      const branch = settings.githubPages?.productionBranch || settings.publishing.productionBranch || "main";
      baselines.push(await gitCommand(dir, ["rev-parse", "--verify", `refs/remotes/origin/${branch}`]).catch(() => null));
      for (const commit of new Set(baselines.filter(Boolean))) {
        try {
          const raw = await gitCommand(dir, ["show", `${commit}:posts/${article.slug}.md`]);
          published = !postFromFile(`${article.slug}.md`, raw).draft;
          break;
        } catch { /* Try another saved production baseline without network access. */ }
      }
    }
    article.status = published ? "published" : "draft";
    article.liveVerification = verified || article.liveRevisionId ? "verified" : "unknown";
    article.hasPendingChanges = !published || !article.liveRevisionId || article.revisionId !== article.liveRevisionId;
    article.publishing = { status: oldStatus === "published" ? "succeeded" : ["draft", "unverified"].includes(oldStatus) ? "idle" : oldStatus, ...(article.error ? { error: article.error } : {}) };
    delete article.error;
  }
  state.version = 2;
  await atomicJson(file, state);
  return state;
}
export async function readLifecycle(dir = contentDir()): Promise<LifecycleState> {
  return withFileLock(path.join(lifecycleDir(dir), "state.lock"), () => loadLifecycle(dir));
}
export async function mutateLifecycle<T>(dir: string, action: (state: LifecycleState) => Promise<T>): Promise<T> {
  return withFileLock(path.join(lifecycleDir(dir), "state.lock"), async () => {
    const state = await loadLifecycle(dir);
    const result = await action(state);
    await atomicJson(path.join(lifecycleDir(dir), "state.json"), state);
    return result;
  });
}
export function withContentLock<T>(dir: string, action: () => Promise<T>) {
  return withFileLock(path.join(lifecycleDir(dir), "content.lock"), action);
}
// Match local asset URLs in Markdown, reference definitions, HTML attributes, and CSS url().
export function discoverAssets(source: string): string[] {
  const paths = new Set<string>();
  for (const match of source.matchAll(/(?<![A-Za-z0-9./:-])\/assets\/[^\s<>"'`),\]}]+/g)) {
    const raw = match[0].split(/[?#]/)[0];
    const decoded = decodeURIComponent(raw.slice(1));
    safePath("/managed", decoded);
    paths.add(decoded);
  }
  return [...paths].sort();
}
export async function workingRevision(dir: string, slug: string, extras: string[] = []) {
  const post = await getPost(slug, dir);
  if (!post) throw new Error(`Post '${slug}' was not found.`);
  const raw = await readManagedFile(dir, `posts/${post.slug}.md`);
  const assets = new Set([...discoverAssets(raw.toString()), ...extras.map(name => name.startsWith("assets/") ? name : `assets/${name}`)]);
  const hashes: Record<string, string> = {};
  const pending = [...assets];
  for (let index = 0; index < pending.length; index++) {
    const filename = pending[index];
    if (!filename.startsWith("assets/")) throw new Error("Article dependencies must be managed assets.");
    const bytes = await readManagedFile(dir, filename);
    hashes[filename] = hash(bytes);
    if (/\.(css|svg)$/i.test(filename)) {
      for (const dependency of discoverAssets(bytes.toString())) if (!assets.has(dependency)) { assets.add(dependency); pending.push(dependency); }
      // Relative CSS dependencies also belong to the immutable asset set.
      if (/\.css$/i.test(filename)) for (const match of bytes.toString().matchAll(/url\(\s*["']?([^\s"')]+)["']?\s*\)/g)) {
        if (/^(?:[a-z]+:|\/|#)/i.test(match[1])) continue;
        const dependency = path.posix.normalize(path.posix.join(path.posix.dirname(filename), decodeURIComponent(match[1].split(/[?#]/)[0])));
        if (!dependency.startsWith("assets/")) throw new Error("CSS dependency escapes managed assets.");
        if (!assets.has(dependency)) { assets.add(dependency); pending.push(dependency); }
      }
    }
  }
  const assetPaths = [...assets].sort();
  const revisionId = hash(JSON.stringify({ article: hash(raw), assets: assetPaths.map(name => [name, hashes[name]]) }));
  return { post, raw, assetPaths, hashes, revisionId };
}
export function updateArticleProgress(state: LifecycleState, record: ArticleRecord) {
  if (record.validationError) {
    record.hasPendingChanges = true; record.publishing = { status: "failed", error: record.validationError }; return;
  }
  record.hasPendingChanges = record.status === "draft" || !record.liveRevisionId || record.revisionId !== record.liveRevisionId;
  const publication = record.publicationId ? state.publications[record.publicationId] : undefined;
  const stage = record.stagedRevisionId ? state.stages[record.stagedRevisionId] : undefined;
  if (publication && (["publishing", "awaiting_merge"].includes(publication.status) || publication.revisionId === record.revisionId)) {
    record.publishing = { status: publication.status, ...(publication.error ? { error: publication.error } : {}) };
  } else if (stage && stage.revisionId === record.revisionId) {
    record.publishing = { status: stage.approvedAt && record.approvedAt ? "ready_to_publish" : stage.previews.desktop && stage.previews.phone ? "awaiting_review" : "staged" };
  } else record.publishing = { status: "idle" };
}
export function isPendingArticle(record: ArticleRecord) {
  return record.hasPendingChanges || !["idle", "succeeded"].includes(record.publishing.status);
}
function reconcileLiveRevision(state: LifecycleState, record: ArticleRecord) {
  const publication = Object.values(state.publications)
    .filter(item => item.status === "succeeded" && (item.slug === record.slug || item.liveRevisions?.[record.slug]))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  const revision = publication?.liveRevisions?.[record.slug] || publication?.revisionId;
  if (revision) {
    record.liveRevisionId = revision; record.status = "published"; record.liveVerification = "verified";
  }
}
export async function reconcileArticle(state: LifecycleState, dir: string, slug: string, edited = false): Promise<ArticleRecord> {
  let record = state.articles[slug];
  let current;
  try { current = await workingRevision(dir, slug, record?.extraAssetPaths || []); }
  catch (error: any) {
    if (!record) {
      const post = await getPost(slug, dir);
      if (!post) throw error;
      record = { slug, revisionId: "", assetPaths: [], status: edited || post.draft ? "draft" : "published", publishing: { status: "idle" }, hasPendingChanges: true, liveVerification: "unknown", updatedAt: now() };
      state.articles[slug] = record;
    }
    reconcileLiveRevision(state, record);
    delete record.approvedAt;
    record.hasPendingChanges = true;
    record.validationError = error.message;
    record.publishing = { status: "failed", error: error.message }; record.updatedAt = now();
    return record;
  }
  if (!record) {
    record = { slug, revisionId: current.revisionId, assetPaths: current.assetPaths, status: edited || current.post.draft ? "draft" : "published", publishing: { status: "idle" }, hasPendingChanges: true, liveVerification: "unknown", updatedAt: now() };
    state.articles[slug] = record;
  } else if (record.revisionId !== current.revisionId) {
    record.revisionId = current.revisionId; record.updatedAt = now();
    delete record.stagedRevisionId; delete record.approvedAt;
    // An already-submitted publication remains independent of the new working revision.
  }
  reconcileLiveRevision(state, record);
  delete record.validationError;
  record.assetPaths = current.assetPaths;
  updateArticleProgress(state, record);
  return record;
}
export function nextAction(record: ArticleRecord) {
  if (record.publishing.status !== "idle" && record.publishing.status !== "succeeded") {
    return ({ staged: "preview", awaiting_review: "review", ready_to_publish: "publish", publishing: "refresh_publication", awaiting_merge: "wait_for_merge", failed: "recover" } as const)[record.publishing.status];
  }
  if (record.status === "published" && record.liveVerification === "unknown" && !record.liveRevisionId) return "reconcile_or_stage";
  return record.hasPendingChanges ? "stage" : "none";
}
export async function articleLifecycle(dir: string, slug: string, edited = false) {
  return mutateLifecycle(dir, async state => {
    const record = await reconcileArticle(state, dir, slug, edited);
    return { ...record, nextAction: nextAction(record), stagedRevision: record.stagedRevisionId ? state.stages[record.stagedRevisionId] : undefined, publication: record.publicationId ? state.publications[record.publicationId] : undefined };
  });
}
export async function pendingLifecycle(dir: string) {
  return mutateLifecycle(dir, async state => {
    const posts = await listPosts(dir, true);
    for (const post of posts) await reconcileArticle(state, dir, post.slug);
    const slugs = new Set(posts.map(post => post.slug));
    return Object.values(state.articles).filter(article => slugs.has(article.slug)).map(article => ({ ...article, nextAction: nextAction(article) }));
  });
}
export function stageDirectory(dir: string, id: string) {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid staged revision identifier.");
  return path.join(lifecycleDir(dir), "stages", id);
}
export async function getStage(dir: string, id: string): Promise<StageRecord> {
  stageDirectory(dir, id);
  const stage = (await readLifecycle(dir)).stages[id];
  if (!stage) throw new Error("Staged revision was not found. Stage the article first.");
  return stage;
}
export async function gitCommand(dir: string, args: string[]) {
  const result = await exec("git", args, { cwd: dir, maxBuffer: 32 * 1024 * 1024, timeout: 30000 });
  return result.stdout.trim();
}
export async function pinnedEngineDirectory(dir: string, engine: StageContext["engine"]) {
  if (!/^[a-f0-9]{40}$/.test(engine.commit)) throw new Error("The engine pin must be a full commit SHA.");
  const destination = path.join(lifecycleDir(dir), "engines", hash(JSON.stringify(engine)));
  return withFileLock(`${destination}.source.lock`, async () => {
    if (!(await fs.stat(path.join(destination, ".git")).catch(() => undefined))) {
      await fs.rm(destination, { recursive: true, force: true }); await fs.mkdir(path.dirname(destination), { recursive: true });
      await gitCommand(path.dirname(destination), ["clone", "--no-checkout", "--", engine.repository, destination]);
      await gitCommand(destination, ["checkout", "--detach", engine.commit]);
    }
    if (await gitCommand(destination, ["rev-parse", "HEAD"]) !== engine.commit || await gitCommand(destination, ["status", "--porcelain", "--untracked-files=no"])) throw new Error("Cached engine differs from its pinned commit.");
    await fs.access(path.join(destination, "packages", "content-contract", "src", "deployment.ts")).catch(() => { throw new Error("Pinned engine lacks article lifecycle support. Upgrade the pushed engine pin before staging or publication."); });
    return destination;
  });
}
export async function engineAssetPaths(dir: string, engine: StageContext["engine"]) {
  const source = await pinnedEngineDirectory(dir, engine);
  const assets = new Set<string>();
  async function walk(directory: string) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(filename);
      else if (entry.isFile() && /\.(astro|css|js|mjs|ts)$/.test(entry.name)) for (const asset of discoverAssets(await fs.readFile(filename, "utf8"))) assets.add(asset);
    }
  }
  await walk(path.join(source, "apps", "site", "src"));
  return [...assets].sort();
}
export async function materializeTree(dir: string, commit: string | null, destination: string) {
  await fs.mkdir(destination, { recursive: true });
  if (!commit) return;
  const { stdout } = await exec("git", ["ls-tree", "-rz", "--full-tree", commit], { cwd: dir, maxBuffer: 32 * 1024 * 1024 });
  for (const entry of stdout.split("\0").filter(Boolean)) {
    const tab = entry.indexOf("\t");
    const [mode, type, object] = entry.slice(0, tab).split(" ");
    if (type !== "blob" || !["100644", "100755"].includes(mode)) throw new Error("Content snapshots do not support symlinks or submodules.");
    const target = safePath(destination, entry.slice(tab + 1));
    const { stdout: bytes } = await exec("git", ["cat-file", "blob", object], { cwd: dir, encoding: "buffer", maxBuffer: 32 * 1024 * 1024 });
    await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, bytes);
  }
}
export async function stageArticle(dir: string, slug: string, context: StageContext, extras?: string[]) {
  return withFileLock(path.join(lifecycleDir(dir), "content.lock"), () => mutateLifecycle(dir, async state => {
    const extraPaths = extras ?? state.articles[slug]?.extraAssetPaths ?? [];
    const current = await workingRevision(dir, slug, extraPaths);
    const manifest = { ...context, slug: current.post.slug, revisionId: current.revisionId, assetPaths: current.assetPaths };
    const id = hash(JSON.stringify(manifest));
    let stage: StageRecord | undefined = state.stages[id];
    const record = await reconcileArticle(state, dir, slug);
    if (stage) {
      try { await verifyStageFiles(dir, stage); }
      catch { stage = undefined; delete state.stages[id]; delete record.stagedRevisionId; delete record.approvedAt; }
    }
    if (!stage) {
      const destination = stageDirectory(dir, id);
      const temporary = `${destination}.${randomUUID()}.tmp`;
      try {
        const content = path.join(temporary, "content");
        await materializeTree(dir, context.baseCommit, content);
        const baselinePosts = await listPosts(content, true);
        for (const asset of current.assetPaths) {
          const target = safePath(content, asset);
          let baseline: Buffer | undefined;
          try { baseline = await fs.readFile(target); } catch (error: any) { if (error.code !== "ENOENT") throw error; }
          if (baseline && hash(baseline) !== current.hashes[asset]) {
            const otherUsers = [];
            for (const post of baselinePosts.filter(post => post.slug !== slug)) if ((await workingRevision(content, post.slug)).assetPaths.includes(asset)) otherUsers.push(post.slug);
            const settingsSources = await Promise.all(["blog.yaml"].map(name => fs.readFile(path.join(content, name), "utf8").catch(() => "")));
            if (otherUsers.length || settingsSources.some(source => discoverAssets(source).includes(asset)) || context.sharedAssetPaths?.includes(asset)) throw new Error(`Shared asset '${asset}' must use a new filename before publication.`);
          }
          await fs.mkdir(path.dirname(target), { recursive: true });
          await fs.writeFile(target, await readManagedFile(dir, asset));
        }
        await writePost({ ...current.post, draft: false }, content);
        const files: Record<string, string> = {};
        for (const filename of [`posts/${slug}.md`, ...current.assetPaths]) files[filename] = hash(await readManagedFile(content, filename));
        let previous: any = {};
        try { previous = JSON.parse(await fs.readFile(path.join(content, ".agentic-publication.json"), "utf8")); } catch (error: any) { if (error.code !== "ENOENT") throw error; }
        await atomicJson(path.join(content, ".agentic-publication.json"), {
          version: 1, publicationId: id, engine: context.engine, buildEnvironment: context.buildEnvironment, files,
          expectedTree: await fileManifest(content, [".agentic-publication.json"]),
          articleRevisions: { ...previous.articleRevisions, [slug]: current.revisionId },
          articleFiles: { ...previous.articleFiles, [slug]: files[`posts/${slug}.md`] },
          articleAssets: { ...previous.articleAssets, [slug]: Object.fromEntries(Object.entries(files).filter(([name]) => name.startsWith("assets/"))) }
        });
        stage = { ...manifest, id, files, snapshotFiles: await fileManifest(content), createdAt: now(), previews: {} };
        await atomicJson(path.join(temporary, "manifest.json"), stage);
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.rm(destination, { recursive: true, force: true });
        await fs.rename(temporary, destination);
        state.stages[id] = stage;
      } finally { await fs.rm(temporary, { recursive: true, force: true }); }
    }
    if (record.stagedRevisionId !== id) { stage.previews = {}; delete stage.approvedAt; delete record.approvedAt; }
    record.revisionId = current.revisionId; record.assetPaths = current.assetPaths;
    record.extraAssetPaths = extraPaths.map(name => name.startsWith("assets/") ? name : `assets/${name}`);
    record.stagedRevisionId = id;
    updateArticleProgress(state, record);
    record.updatedAt = now();
    return { ...stage, stagedRevisionId: id, route: `/posts/${slug}/`, status: record.status, publishing: record.publishing, hasPendingChanges: record.hasPendingChanges };
  }));
}
export async function verifyStageFiles(dir: string, stage: StageRecord) {
  const content = path.join(stageDirectory(dir, stage.id), "content");
  if (JSON.stringify(await fileManifest(content)) !== JSON.stringify(stage.snapshotFiles)) throw new Error("Saved snapshot changed. Stage and review a new revision.");
  return content;
}
export async function recordPreview(dir: string, id: string, viewport: "desktop" | "phone", route: string, screenshot: string) {
  return mutateLifecycle(dir, async state => {
    const stage = state.stages[id];
    if (!stage) throw new Error("Staged revision was not found.");
    if (route.replace(/\/$/, "") !== `/posts/${stage.slug}`) return;
    await verifyStageFiles(dir, stage);
    stage.previews[viewport] = { route, screenshot, checkedAt: now() };
    const article = await reconcileArticle(state, dir, stage.slug);
    if (article.stagedRevisionId === id && article.revisionId === stage.revisionId && !article.approvedAt) updateArticleProgress(state, article);
  });
}
export async function approveArticle(dir: string, id: string) {
  return withFileLock(path.join(lifecycleDir(dir), "content.lock"), () => mutateLifecycle(dir, async state => {
    const stage = state.stages[id];
    if (!stage) throw new Error("Staged revision was not found.");
    await verifyStageFiles(dir, stage);
    const record = await reconcileArticle(state, dir, stage.slug);
    if (record.stagedRevisionId !== id || record.revisionId !== stage.revisionId) throw new Error("Revision is stale. Stage, preview, and review the current revision.");
    if (!stage.previews.desktop || !stage.previews.phone) throw new Error("Desktop and phone previews are required before approval.");
    for (const evidence of Object.values(stage.previews)) await fs.access(evidence!.screenshot);
    stage.approvedAt = now(); record.approvedAt = stage.approvedAt; updateArticleProgress(state, record); record.updatedAt = now();
    return { stagedRevisionId: id, approvedAt: stage.approvedAt, status: record.status, publishing: record.publishing };
  }));
}
export async function updatePublication(dir: string, publication: Publication) {
  publication.updatedAt = now();
  return mutateLifecycle(dir, async state => {
    state.publications[publication.id] = publication;
    if (publication.slug) {
      const article = await reconcileArticle(state, dir, publication.slug);
      article.publicationId = publication.id;
      if (publication.status === "succeeded") {
        article.liveRevisionId = publication.revisionId; article.status = "published"; article.liveVerification = "verified";
      }
      updateArticleProgress(state, article);
    }
    return publication;
  });
}
