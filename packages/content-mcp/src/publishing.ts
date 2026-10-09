import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  hash, now, readSettings, readLifecycle, mutateLifecycle, reconcileArticle, lifecycleDir,
  stageDirectory, verifyStageFiles, readManagedFile, safePath, gitCommand, updatePublication,
  withFileLock, withContentLock, writeManagedFile, discoverAssets, workingRevision, listPosts, engineAssetPaths, fileManifest,
  type StageContext, type Publication, type StageRecord
} from "@agentic-blog/content-contract";

const exec = promisify(execFile);
export interface HostingProvider {
  context(dir: string): Promise<StageContext>;
  submit(publication: Publication, checkout: string): Promise<Partial<Publication>>;
  inspect(publication: Publication): Promise<Partial<Publication>>;
  retry(publication: Publication): Promise<Partial<Publication>>;
  verify(publication: Publication): Promise<string | { url: string; articleRevisions: Record<string, string> }>;
}
async function gh(args: string[]) {
  const { stdout } = await exec("gh", args, { timeout: 20000, maxBuffer: 8 * 1024 * 1024 });
  return stdout.trim();
}
export function githubRepository(remote: string) {
  const match = remote.match(/^(?:git@github\.com:|https:\/\/github\.com\/|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/);
  if (!match) throw new Error("GitHub Pages publication requires a github.com content origin.");
  return match[1];
}
function engineUrl(repository: string) {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ? `https://github.com/${repository}.git` : repository;
}
export async function fetchProduction(dir: string, remote: string, branch: string) {
  await gitCommand(dir, ["check-ref-format", "--branch", branch]);
  const output = await gitCommand(dir, ["ls-remote", "--heads", remote, `refs/heads/${branch}`]);
  if (!output) return null;
  const commit = output.split(/\s+/)[0];
  await gitCommand(dir, ["fetch", "--no-tags", remote, `refs/heads/${branch}`]);
  const fetched = await gitCommand(dir, ["rev-parse", "FETCH_HEAD"]);
  if (fetched !== commit) throw new Error("Production branch changed during fetch. Retry staging.");
  return commit;
}
export class GithubPagesProvider implements HostingProvider {
  constructor(private readonly command: (args: string[]) => Promise<string> = gh, private readonly request: typeof fetch = fetch) {}
  private async api(endpoint: string, method = "GET") {
    const output = await this.command(["api", endpoint, "--method", method]);
    return output ? JSON.parse(output) : undefined;
  }
  private async variable(repository: string, name: string, optional = false) {
    try { return String((await this.api(`repos/${repository}/actions/variables/${name}`)).value || ""); }
    catch (error: any) { if (optional && /HTTP 404/.test(error.stderr || "")) return ""; throw error; }
  }
  async context(dir: string): Promise<StageContext> {
    const settings = await readSettings(dir);
    const provider = settings.hosting || (settings.githubPages ? "github-pages" : settings.cloudflare ? "cloudflare-pages" : undefined);
    if (provider !== "github-pages") throw new Error(provider === "cloudflare-pages" ? "Cloudflare Pages publication is not implemented yet. Existing configuration is preserved." : "Configure GitHub Pages before staging or publication.");
    // Read the configured identity before Git's transport-only insteadOf rewrites.
    const remote = await gitCommand(dir, ["config", "--get", "remote.origin.url"]);
    const repository = githubRepository(remote);
    const branch = settings.githubPages?.productionBranch || settings.publishing.productionBranch;
    const [engineRepository, engineCommit, analyticsToken, baseCommit] = await Promise.all([
      this.variable(repository, "BLOG_ENGINE_REPOSITORY"), this.variable(repository, "BLOG_ENGINE_COMMIT"),
      this.variable(repository, "CLOUDFLARE_WEB_ANALYTICS_TOKEN", true), fetchProduction(dir, remote, branch)
    ]);
    if (!engineRepository || !/^[a-f0-9]{40}$/.test(engineCommit)) throw new Error("Set BLOG_ENGINE_REPOSITORY and BLOG_ENGINE_COMMIT to an accessible engine repository and full pushed commit SHA.");
    const engine = { repository: engineUrl(engineRepository), commit: engineCommit };
    return { provider, repository, remote, productionBranch: branch, baseCommit, engine,
      sharedAssetPaths: await engineAssetPaths(dir, engine),
      buildEnvironment: analyticsToken ? { PUBLIC_CLOUDFLARE_WEB_ANALYTICS_TOKEN: analyticsToken } : {} };
  }
  async submit(publication: Publication): Promise<Partial<Publication>> {
    if (publication.mode === "push") return { status: "publishing", step: "submitted" };
    const existing = JSON.parse(await this.command(["pr", "list", "--repo", publication.context.repository, "--head", publication.branch, "--state", "all", "--json", "number,url,state"]));
    if (existing.length) return { prNumber: existing[0].number, prUrl: existing[0].url, status: "awaiting_merge", step: "submitted" };
    const prUrl = await this.command(["pr", "create", "--repo", publication.context.repository, "--head", publication.branch,
      "--base", publication.context.productionBranch, "--title", publication.message.split("\n")[0],
      "--body", `Reviewed publication ${publication.id}\n\nStaged revision: ${publication.stagedRevisionId || "explicit site changes"}`]);
    return { prUrl, prNumber: Number(prUrl.split("/").pop()), status: "awaiting_merge", step: "submitted" };
  }
  async inspect(publication: Publication): Promise<Partial<Publication>> {
    let commit = publication.mergeCommit || publication.commit;
    if (publication.mode === "pr") {
      const pr = await this.api(`repos/${publication.context.repository}/pulls/${publication.prNumber}`);
      if (!pr.merged) return pr.state === "closed" ? { status: "failed", error: "Pull request closed without merging.", recoverable: false } : { status: "awaiting_merge" };
      commit = pr.merge_commit_sha;
    }
    const endpoint = `repos/${publication.context.repository}/actions/workflows/deploy.yml/runs?head_sha=${commit}&branch=${encodeURIComponent(publication.context.productionBranch)}&per_page=20`;
    const runs = (await this.api(endpoint)).workflow_runs.filter((run: any) => ["push", "workflow_dispatch"].includes(run.event));
    const run = runs.sort((a: any, b: any) => b.id - a.id || b.run_attempt - a.run_attempt)[0];
    if (!run) return { status: "publishing", mergeCommit: publication.mode === "pr" ? commit : undefined };
    const result: Partial<Publication> = { mergeCommit: publication.mode === "pr" ? commit : undefined, runId: run.id, runAttempt: run.run_attempt, workflowUrl: run.html_url, status: "publishing", step: "submitted" };
    if (run.status === "completed") {
      if (run.conclusion === "success") result.step = "deployed";
      else { result.status = "failed"; result.error = `Deployment concluded ${run.conclusion}.`; result.recoverable = true; }
    }
    return result;
  }
  async retry(publication: Publication): Promise<Partial<Publication>> {
    if (!publication.recoverable) throw new Error("Publication needs intervention or a new reviewed revision.");
    if (publication.runId) {
      const run = await this.api(`repos/${publication.context.repository}/actions/runs/${publication.runId}`);
      // A lost rerun response must not rerun the same workflow again.
      if (run.status === "completed" && run.conclusion !== "success" && run.run_attempt <= (publication.runAttempt || 1)) {
        await this.api(`repos/${publication.context.repository}/actions/runs/${publication.runId}/rerun`, "POST");
      }
      return { status: "publishing", step: "submitted", error: undefined, recoverable: undefined };
    }
    return { status: "publishing", error: undefined, recoverable: undefined };
  }
  async verify(publication: Publication) {
    const pages = await this.api(`repos/${publication.context.repository}/pages`);
    if (!pages.html_url) throw new Error("GitHub Pages has not reported a public URL yet.");
    const base = new URL(pages.html_url);
    const fetchBytes = async (relative: string) => {
      const url = new URL(relative.replace(/^\//, ""), base);
      url.searchParams.set("publication", publication.id);
      const response = await this.request(url, { cache: "no-store", signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error(`Live verification returned HTTP ${response.status} for ${relative}.`);
      return Buffer.from(await response.arrayBuffer());
    };
    const manifest = JSON.parse((await fetchBytes("publication-manifest.json")).toString());
    if (manifest.publicationId !== publication.id || manifest.engine.commit !== publication.context.engine.commit) throw new Error("Live publication or engine marker differs from the reviewed snapshot.");
    if (publication.slug) {
      if (manifest.articleRevisions[publication.slug] !== publication.revisionId) throw new Error("Live article revision differs from the approved revision.");
      const route = `posts/${publication.slug}/`;
      const html = (await fetchBytes(route)).toString();
      if (!html.includes(`name="agentic-blog-revision" content="${publication.revisionId}"`)) throw new Error("Live HTML does not contain the approved article revision marker.");
      for (const [filename, digest] of Object.entries(publication.files)) if (filename.startsWith("assets/") && hash(await fetchBytes(filename)) !== digest) throw new Error(`Live asset differs from approved bytes: ${filename}`);
      return { url: new URL(route, base).href, articleRevisions: manifest.articleRevisions as Record<string, string> };
    }
    return { url: base.href, articleRevisions: manifest.articleRevisions as Record<string, string> };
  }
}
export const githubPages = new GithubPagesProvider();
function sameContext(a: StageContext, b: StageContext) {
  const comparable = (value: StageContext) => JSON.stringify({ provider: value.provider, repository: value.repository, remote: value.remote,
    productionBranch: value.productionBranch, baseCommit: value.baseCommit, engine: [value.engine.repository, value.engine.commit],
    buildEnvironment: Object.entries(value.buildEnvironment).sort(([a], [b]) => a.localeCompare(b)), sharedAssetPaths: [...(value.sharedAssetPaths || [])].sort() });
  return comparable(a) === comparable(b);
}
async function assertCurrentStage(dir: string, stage: StageRecord) {
  await verifyStageFiles(dir, stage);
  await mutateLifecycle(dir, async state => {
    const article = await reconcileArticle(state, dir, stage.slug);
    const saved = state.stages[stage.id];
    if (article.revisionId !== stage.revisionId || article.stagedRevisionId !== stage.id || !article.approvedAt || !saved?.approvedAt || !saved.previews.desktop || !saved.previews.phone) throw new Error("Publication requires the current approved revision and desktop/phone previews.");
  });
}
export interface PublishInput { stagedRevisionId?: string; publicationId?: string; paths?: string[]; message: string; mode?: "push" | "pr"; }
export async function publish(dir: string, input: PublishInput, provider: HostingProvider = githubPages) {
  return withFileLock(path.join(lifecycleDir(dir), "publication.lock"), () => withContentLock(dir, async () => {
    if ([input.stagedRevisionId, input.publicationId, input.paths?.length].filter(Boolean).length !== 1) throw new Error("Select exactly one stagedRevisionId, publicationId to resume, or a non-empty explicit paths list. Unrestricted publication is disabled.");
    const state = await readLifecycle(dir);
    const prior = input.publicationId ? state.publications[input.publicationId] : input.stagedRevisionId ? Object.values(state.publications).find(item => item.stagedRevisionId === input.stagedRevisionId) : undefined;
    if (input.publicationId && !prior) throw new Error("Publication was not found.");
    if (prior?.status === "succeeded") return prior;
    const active = Object.values(state.publications).find(item => ["publishing", "awaiting_merge"].includes(item.status) && item.id !== prior?.id);
    if (active) throw new Error(`Publication ${active.id} is still active. Refresh it before submitting another publication.`);
    let publication = prior;
    if (publication?.status === "failed" && !publication.recoverable) throw new Error(publication.error || "Publication requires intervention.");
    if (!publication) {
      const context = await provider.context(dir);
      const settings = await readSettings(dir);
      const mode = input.mode || settings.publishing.mode;
      if (mode === "unset") throw new Error("Publishing policy is unset. Choose push or pr through set_publishing_policy.");
      let stage: StageRecord | undefined;
      let files: Record<string, string> = {};
      if (input.stagedRevisionId) {
        stage = state.stages[input.stagedRevisionId];
        if (!stage) throw new Error("Staged revision was not found.");
        await assertCurrentStage(dir, stage);
        if (!sameContext(stage, context)) throw new Error("Production baseline, configuration, or engine pin changed. Restage, preview, and approve again.");
        files = stage.files;
      } else {
        const posts = await listPosts(dir, true);
        const articleAssets = new Set((await Promise.all(posts.map(async post => discoverAssets((await readManagedFile(dir, `posts/${post.slug}.md`)).toString())))).flat());
        for (const post of posts) for (const asset of (await workingRevision(dir, post.slug).catch(() => ({ assetPaths: [] as string[] }))).assetPaths) articleAssets.add(asset);
        for (const filename of [...new Set(input.paths!)]) {
          safePath(dir, filename);
          if (filename.startsWith("posts/") || filename === ".agentic-publication.json" || articleAssets.has(filename)) throw new Error("Article content and article assets require an approved staged revision.");
          files[filename] = hash(await readManagedFile(dir, filename));
        }
      }
      const id = hash(JSON.stringify({ stage: stage?.id, context, files, mode }));
      if (state.publications[id]) return state.publications[id];
      publication = { id, stagedRevisionId: stage?.id, slug: stage?.slug, revisionId: stage?.revisionId, context, files, mode, message: input.message,
        status: "publishing", step: "prepared", branch: mode === "pr" ? `agent/publication-${id.slice(0, 24)}` : context.productionBranch, createdAt: now(), updatedAt: now() };
      const selected = path.join(lifecycleDir(dir), "publications", id, "selected");
      for (const filename of Object.keys(files)) {
        const bytes = await readManagedFile(stage ? path.join(stageDirectory(dir, stage.id), "content") : dir, filename);
        if (hash(bytes) !== files[filename]) throw new Error("Selected files changed during publication preparation. Retry with a reviewed selection.");
        const target = safePath(selected, filename); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, bytes);
      }
      await updatePublication(dir, publication);
    }
    try {
      if (publication.status === "failed") {
        Object.assign(publication, await provider.retry(publication));
        await updatePublication(dir, publication);
      }
      const checkout = path.join(lifecycleDir(dir), "publications", publication.id, "checkout");
      if (publication.step === "prepared") {
        try {
          const metadata = JSON.parse(await gitCommand(checkout, ["show", "HEAD:.agentic-publication.json"]));
          if (metadata.publicationId === publication.id) {
            for (const [filename, digest] of Object.entries(publication.files)) {
              const { stdout } = await exec("git", ["show", `HEAD:${filename}`], { cwd: checkout, encoding: "buffer", maxBuffer: 32 * 1024 * 1024 });
              if (hash(stdout) !== digest) throw new Error("Saved commit differs from selected publication bytes.");
            }
            publication.commit = await gitCommand(checkout, ["rev-parse", "HEAD"]); publication.step = "committed";
            await updatePublication(dir, publication);
          }
        } catch (error: any) { if (error.message === "Saved commit differs from selected publication bytes.") throw Object.assign(error, { recoverable: false }); }
      }
      if (publication.step === "prepared") {
        const latest = await provider.context(dir);
        if (!sameContext(publication.context, latest)) throw Object.assign(new Error("Production baseline or engine pin changed. Restage and approve again."), { recoverable: false });
        if (publication.stagedRevisionId) await assertCurrentStage(dir, await importStage(dir, publication.stagedRevisionId));
        // Recreate only an unsubmitted checkout. All selected bytes are already durable.
        await fs.rm(checkout, { recursive: true, force: true }); await fs.mkdir(checkout, { recursive: true });
        await gitCommand(checkout, ["init", "--initial-branch", publication.branch]);
        await gitCommand(checkout, ["remote", "add", "origin", publication.context.remote]);
        if (publication.context.baseCommit) {
          await gitCommand(checkout, ["fetch", "--no-tags", "origin", publication.context.productionBranch]);
          if (await gitCommand(checkout, ["rev-parse", "FETCH_HEAD"]) !== publication.context.baseCommit) throw Object.assign(new Error("Production changed before commit preparation. Restage and approve."), { recoverable: false });
          await gitCommand(checkout, ["reset", "--hard", publication.context.baseCommit]);
        }
        for (const key of ["user.name", "user.email"]) {
          const value = await gitCommand(dir, ["config", "--get", key]).catch(() => "");
          if (value) await gitCommand(checkout, ["config", key, value]);
        }
        const selected = path.join(lifecycleDir(dir), "publications", publication.id, "selected");
        for (const [filename, digest] of Object.entries(publication.files)) {
          const bytes = await readManagedFile(selected, filename);
          if (hash(bytes) !== digest) throw Object.assign(new Error("Saved publication bytes changed."), { recoverable: false });
          await writeManagedFile(checkout, filename, bytes);
        }
        let previous: any = {};
        try { previous = JSON.parse(await fs.readFile(path.join(checkout, ".agentic-publication.json"), "utf8")); } catch (error: any) { if (error.code !== "ENOENT") throw error; }
        const articleRevisions = previous.articleRevisions || {};
        const articleFiles = previous.articleFiles || {};
        const articleAssets = previous.articleAssets || {};
        if (publication.slug) articleRevisions[publication.slug] = publication.revisionId!;
        if (publication.slug) {
          articleFiles[publication.slug] = publication.files[`posts/${publication.slug}.md`];
          articleAssets[publication.slug] = Object.fromEntries(Object.entries(publication.files).filter(([name]) => name.startsWith("assets/")));
        }
        const expectedTree = publication.stagedRevisionId
          ? Object.fromEntries(Object.entries((await importStage(dir, publication.stagedRevisionId)).snapshotFiles).filter(([name]) => name !== ".agentic-publication.json"))
          : await fileManifest(checkout, [".git", ".agentic-publication.json"]);
        await writeManagedFile(checkout, ".agentic-publication.json", JSON.stringify({ version: 1, publicationId: publication.id, engine: publication.context.engine, buildEnvironment: publication.context.buildEnvironment, expectedTree, files: publication.files, articleRevisions, articleFiles, articleAssets }, null, 2));
        await gitCommand(checkout, ["add", "--", ...Object.keys(publication.files), ".agentic-publication.json"]);
        await gitCommand(checkout, ["commit", "-m", publication.message]);
        publication.commit = await gitCommand(checkout, ["rev-parse", "HEAD"]); publication.step = "committed";
        await updatePublication(dir, publication);
      }
      if (publication.step === "committed") {
        // Before first submission the approval must still be current. A retry after a lost push response checks the remote first.
        const remoteHead = await gitCommand(checkout, ["ls-remote", "--heads", "origin", `refs/heads/${publication.branch}`]);
        const remoteCommit = remoteHead.split(/\s+/)[0] || null;
        if (remoteCommit !== publication.commit) {
          if (publication.stagedRevisionId) await assertCurrentStage(dir, await importStage(dir, publication.stagedRevisionId));
          const latest = await provider.context(dir);
          if (!sameContext(publication.context, latest)) throw Object.assign(new Error("Production or engine pin changed before push. Restage and approve."), { recoverable: false });
          await gitCommand(checkout, ["push", "origin", `${publication.commit}:refs/heads/${publication.branch}`]);
        }
        publication.step = "pushed"; await updatePublication(dir, publication);
      }
      if (publication.step === "pushed") {
        Object.assign(publication, await provider.submit(publication, checkout));
        await updatePublication(dir, publication);
      }
      return publication;
    } catch (error: any) {
      publication.status = "failed"; publication.error = error.message; publication.recoverable = error.recoverable !== false;
      await updatePublication(dir, publication);
      return publication;
    }
  }));
}
async function importStage(dir: string, id: string) {
  const stage = (await readLifecycle(dir)).stages[id];
  if (!stage) throw new Error("Staged revision was not found.");
  return stage;
}
export async function refreshPublication(dir: string, id: string, provider: HostingProvider = githubPages) {
  return withFileLock(path.join(lifecycleDir(dir), "publication.lock"), async () => {
    const publication = (await readLifecycle(dir)).publications[id];
    if (!publication) throw new Error("Publication was not found.");
    if (publication.status === "succeeded" || publication.status === "failed") return publication;
    try {
      if (["prepared", "committed", "pushed"].includes(publication.step)) return { ...publication, nextAction: "retry_commit_and_publish" };
      const latest = await provider.inspect(publication);
      Object.assign(publication, latest); publication.observedAt = now();
      if (publication.mergeCommit) {
        await gitCommand(dir, ["fetch", "--no-tags", publication.context.remote, publication.mergeCommit]);
        const checkout = path.join(lifecycleDir(dir), "publications", publication.id, "checkout");
        await gitCommand(checkout, ["fetch", "--no-tags", "origin", publication.mergeCommit]);
        if (await gitCommand(checkout, ["rev-parse", `${publication.mergeCommit}^{tree}`]) !== await gitCommand(checkout, ["rev-parse", `${publication.commit}^{tree}`])) throw Object.assign(new Error("Merged tree differs from the reviewed production context. Restage, preview, and approve again."), { terminal: true });
        for (const [filename, digest] of Object.entries(publication.files)) {
          const { stdout } = await exec("git", ["show", `${publication.mergeCommit}:${filename}`], { cwd: dir, encoding: "buffer", maxBuffer: 32 * 1024 * 1024 });
          if (hash(stdout) !== digest) throw Object.assign(new Error("Merged content differs from the reviewed snapshot. A new preview and approval are required."), { terminal: true });
        }
      }
      if (publication.step === "deployed" && latest.status !== "failed") {
        const verified = await provider.verify(publication);
        publication.liveUrl = typeof verified === "string" ? verified : verified.url;
        publication.liveRevisions = typeof verified === "string" ? undefined : verified.articleRevisions;
        publication.step = "verified"; publication.status = "succeeded"; delete publication.error; delete publication.retryAfter;
      }
    } catch (error: any) {
      publication.error = error.message; publication.observedAt = now();
      publication.retryAfter = new Date(Date.now() + 5000).toISOString();
      if (error.terminal) { publication.status = "failed"; publication.recoverable = false; }
      // Network errors and stale CDN responses retain the current checkpoint for another bounded refresh.
    }
    return updatePublication(dir, publication);
  });
}
