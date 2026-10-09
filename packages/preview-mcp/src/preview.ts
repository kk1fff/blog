import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import os from "node:os";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { chromium } from "playwright";
import { getStage, stageDirectory, verifyStageFiles, lifecycleDir, withFileLock, gitCommand, hash, pinnedEngineDirectory, atomicJson, mutateLifecycle, updateArticleProgress, type StageRecord } from "@agentic-blog/content-contract";

const buildController = new AbortController();
export function cancelPreviewBuilds() { buildController.abort(); }
const mime: Record<string, string> = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".webp": "image/webp", ".woff2": "font/woff2" };
export function networkAddresses(interfaces = os.networkInterfaces()) {
  return Object.entries(interfaces).flatMap(([name, addresses]) => (addresses || []).map(address => ({
    interface: name, address: address.address, family: address.family, internal: address.internal,
    linkLocal: address.address.startsWith("fe80:") || address.address.startsWith("169.254."),
    tailscale: /tailscale/i.test(name),
  }))).sort((a, b) => Number(b.tailscale) - Number(a.tailscale) || Number(a.internal) - Number(b.internal) || Number(a.linkLocal) - Number(b.linkLocal) || a.family.localeCompare(b.family) || a.address.localeCompare(b.address));
}
function tokenMatches(provided: string | undefined, expected: string) {
  if (!provided) return false;
  const a = Buffer.from(provided); const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
export interface ActivePreview {
  id: string; directory: string; route: string; token: string; cookie: string;
  listeners: http.Server[]; port: number; ipv6: boolean; openedAt: string;
}
export class PreviewServers {
  private active = new Map<string, ActivePreview>();
  private pending = new Map<string, Promise<ActivePreview>>();
  private generation = 0;
  private disposed = false;
  epoch() { return this.generation; }
  async dispose() { this.disposed = true; return this.stop(); }
  async open(id: string, directory: string, route: string): Promise<ActivePreview> {
    if (this.disposed) throw new Error("Preview MCP connection is closed.");
    const existing = this.active.get(id);
    if (existing) return existing;
    const inFlight = this.pending.get(id);
    if (inFlight) return inFlight;
    const generation = this.generation;
    const promise = this.start(id, directory, route).then(async preview => {
      if (generation !== this.generation) { await this.shutdown(preview); throw new Error("Preview opening was cancelled by shutdown."); }
      this.active.set(id, preview); return preview;
    }).finally(() => this.pending.delete(id));
    this.pending.set(id, promise); return promise;
  }
  private async start(id: string, directory: string, route: string) {
    const preview: ActivePreview = { id, directory, route, token: randomBytes(32).toString("base64url"), cookie: `agentic_preview_${hash(id).slice(0, 16)}`, listeners: [], port: 0, ipv6: true, openedAt: new Date().toISOString() };
    const root = await fs.realpath(directory);
    const server = http.createServer(async (request, response) => {
      try {
        const url = new URL(request.url || "/", "http://preview");
        response.setHeader("Cache-Control", "no-store");
        response.setHeader("Referrer-Policy", "no-referrer");
        response.setHeader("X-Robots-Tag", "noindex, nofollow");
        const cookie = request.headers.cookie?.split(";").map(item => item.trim()).find(item => item.startsWith(`${preview.cookie}=`))?.slice(preview.cookie.length + 1);
        const suppliedToken = url.searchParams.get("previewToken") || undefined;
        if (tokenMatches(suppliedToken, preview.token)) {
          response.setHeader("Set-Cookie", `${preview.cookie}=${preview.token}; HttpOnly; SameSite=Lax; Path=/`);
          url.searchParams.delete("previewToken");
          response.writeHead(303, { Location: `${url.pathname}${url.search}` }); response.end(); return;
        }
        if (!tokenMatches(cookie, preview.token)) { response.writeHead(403); response.end("Open the secret preview link first."); return; }
        if (!["GET", "HEAD"].includes(request.method || "")) { response.writeHead(405); response.end(); return; }
        const requested = decodeURIComponent(url.pathname);
        if (requested.includes("\\") || requested.includes("\0") || requested.split("/").some(part => part === ".." || part.startsWith("."))) throw new Error("Unsafe preview path.");
        let target = path.resolve(root, `.${requested}`);
        if (target !== root && !target.startsWith(root + path.sep)) throw new Error("Unsafe preview path.");
        const stat = await fs.stat(target);
        if (stat.isDirectory()) target = path.join(target, "index.html");
        const real = await fs.realpath(target);
        if (!real.startsWith(root + path.sep)) throw new Error("Preview path escapes build directory.");
        const bytes = await fs.readFile(real);
        response.writeHead(200, { "Content-Type": mime[path.extname(real)] || "application/octet-stream" });
        response.end(request.method === "HEAD" ? undefined : bytes);
      } catch { response.writeHead(404); response.end("Not found"); }
    });
    server.requestTimeout = 15000; server.headersTimeout = 15000;
    const listen = (host: string, port: number, ipv6Only?: boolean) => new Promise<void>((resolve, reject) => {
      const failed = (error: Error) => { server.off("listening", ready); reject(error); };
      const ready = () => { server.off("error", failed); resolve(); };
      server.once("error", failed); server.once("listening", ready); server.listen({ host, port, ipv6Only });
    });
    try { await listen("::", 0, false); }
    catch (error: any) {
      if (!["EAFNOSUPPORT", "EADDRNOTAVAIL", "EPROTONOSUPPORT"].includes(error.code)) throw error;
      preview.ipv6 = false; await listen("0.0.0.0", 0);
    }
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Preview server did not return a listening address.");
    preview.port = address.port; preview.listeners.push(server);
    return preview;
  }
  info(preview: ActivePreview) {
    const addresses = networkAddresses().map(address => {
      const usable = !address.linkLocal && (address.family === "IPv4" || preview.ipv6);
      const host = address.family === "IPv6" ? `[${address.address}]` : address.address;
      return { ...address, listening: usable, note: address.internal ? "Only reachable on the workspace machine" : address.linkLocal ? "Requires interface scope; not advertised as a browser link" : "Discovered address; client reachability depends on routing", url: usable ? `http://${host}:${preview.port}${preview.route}?previewToken=${preview.token}` : undefined };
    });
    return { previewId: preview.id, mode: preview.id.startsWith("local-") ? "workspace" : "staged", stagedRevisionId: preview.id.startsWith("local-") ? undefined : preview.id, status: "running", port: preview.port, route: preview.route, openedAt: preview.openedAt, addresses, urls: addresses.flatMap(address => address.url ? [address.url] : []) };
  }
  get(id: string) {
    const preview = this.active.get(id);
    if (!preview) throw new Error("Preview is not running. Open it first.");
    return preview;
  }
  status(id?: string) { return [...this.active.values()].filter(preview => !id || preview.id === id).map(preview => this.info(preview)); }
  private async shutdown(preview: ActivePreview) {
    preview.token = randomBytes(32).toString("base64url");
    await Promise.all(preview.listeners.map(server => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); })));
  }
  async close(id: string) {
    const opening = this.pending.get(id);
    if (opening) await opening.catch(() => undefined);
    const preview = this.active.get(id);
    if (preview) { this.active.delete(id); await this.shutdown(preview); }
    return { previewId: id, stagedRevisionId: id.startsWith("local-") ? undefined : id, status: "closed", retainedBuild: true };
  }
  async stop() {
    this.generation++;
    await Promise.allSettled([...this.pending.values()]);
    await Promise.all([...this.active.keys()].map(id => this.close(id)));
    return { status: "stopped", retainedBuilds: true };
  }
}
export async function runPreviewCommand(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  if (buildController.signal.aborted) throw new Error("Preview MCP closed during build.");
  await new Promise<void>((resolve, reject) => {
    const grouped = process.platform !== "win32";
    const child = spawn(command, args, { cwd, env, detached: grouped, stdio: "pipe" });
    let output = ""; let timedOut = false;
    const collect = (data: Buffer) => { output = (output + data.toString()).slice(-8 * 1024 * 1024); };
    child.stdout.on("data", collect); child.stderr.on("data", collect);
    const kill = (signal: NodeJS.Signals) => {
      try { if (grouped && child.pid) process.kill(-child.pid, signal); else child.kill(signal); } catch (error: any) { if (error.code !== "ESRCH") reject(error); }
    };
    const aborted = () => kill("SIGTERM");
    buildController.signal.addEventListener("abort", aborted, { once: true });
    const timeout = setTimeout(() => { timedOut = true; kill("SIGKILL"); }, 240000);
    const cleanup = () => { clearTimeout(timeout); buildController.signal.removeEventListener("abort", aborted); };
    child.once("error", error => { cleanup(); reject(error); });
    child.once("close", code => {
      cleanup();
      if (buildController.signal.aborted) reject(new Error("Preview MCP closed during build."));
      else if (timedOut) reject(new Error("Preview build timed out."));
      else if (code !== 0) reject(new Error(output || `Preview command exited ${code}.`));
      else resolve();
    });
  });
}
async function treeDigest(directory: string): Promise<string> {
  const files: [string, string][] = [];
  async function walk(relative: string) {
    for (const entry of (await fs.readdir(path.join(directory, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) await walk(name);
      else if (entry.isFile()) files.push([name, hash(await fs.readFile(path.join(directory, name)))]);
      else throw new Error("Build artifacts must not contain symlinks.");
    }
  }
  await walk(""); return hash(JSON.stringify(files));
}
export async function buildStage(dir: string, stage: StageRecord) {
  const directory = stageDirectory(dir, stage.id);
  return withFileLock(path.join(directory, "build.lock"), async () => {
    const content = await verifyStageFiles(dir, stage);
    const output = path.join(directory, "build");
    const receipt = path.join(directory, "build-receipt.json");
    let repair = false;
    try {
      const saved = JSON.parse(await fs.readFile(receipt, "utf8"));
      if (saved.engineCommit === stage.engine.commit && saved.digest === await treeDigest(output)) return output;
      repair = true;
    } catch (error: any) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
      repair = Boolean(await fs.stat(output).catch(() => undefined));
    }
    if (repair) await mutateLifecycle(dir, async state => {
      const saved = state.stages[stage.id];
      saved.previews = {}; delete saved.approvedAt;
      const article = state.articles[stage.slug];
      if (article?.stagedRevisionId === stage.id) { delete article.approvedAt; updateArticleProgress(state, article); }
    });
    const engine = await pinnedEngineDirectory(dir, stage.engine);
    await withFileLock(`${engine}.lock`, async () => {
      const dependencyReceipt = path.join(engine, ".agentic-blog", "dependencies-ready.json");
      if (!(await fs.stat(dependencyReceipt).catch(() => undefined))) {
        await runPreviewCommand("npm", ["ci"], engine, process.env);
        await atomicJson(dependencyReceipt, { engineCommit: stage.engine.commit });
      }
      if (await gitCommand(engine, ["rev-parse", "HEAD"]) !== stage.engine.commit || await gitCommand(engine, ["status", "--porcelain", "--untracked-files=no"])) throw new Error("Cached engine differs from its pinned commit.");
      const temporary = `${output}.tmp`;
      await fs.rm(temporary, { recursive: true, force: true });
      try {
        await runPreviewCommand("npm", ["run", "build"], engine, { ...process.env, ...stage.buildEnvironment, BLOG_CONTENT_DIR: content, BLOG_OUTPUT_DIR: temporary, BLOG_ENGINE_COMMIT: stage.engine.commit, BLOG_PREVIEW_LOCAL: "" });
        const manifest = JSON.parse(await fs.readFile(path.join(temporary, "publication-manifest.json"), "utf8"));
        if (manifest.articleRevisions[stage.slug] !== stage.revisionId) throw new Error("Pinned build did not render the staged article revision.");
        await fs.rm(output, { recursive: true, force: true }); await fs.rename(temporary, output);
        await atomicJson(receipt, { engineCommit: stage.engine.commit, digest: await treeDigest(output) });
      } finally { await fs.rm(temporary, { recursive: true, force: true }); }
    });
    return output;
  });
}
export async function stagedPreview(dir: string, id: string, servers: PreviewServers) {
  const epoch = servers.epoch();
  const stage = await getStage(dir, id);
  const build = await buildStage(dir, stage);
  if (servers.epoch() !== epoch) throw new Error("Preview opening was cancelled by shutdown.");
  const preview = await servers.open(id, build, `/posts/${stage.slug}/`);
  return { stage, preview, info: { ...servers.info(preview), revisionId: stage.revisionId, engineCommit: stage.engine.commit } };
}
export async function capture(preview: ActivePreview, route: string, viewport: "desktop" | "phone", filename: string) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: viewport === "desktop" ? { width: 1280, height: 800 } : { width: 390, height: 844 }, deviceScaleFactor: 1 });
    const base = `http://127.0.0.1:${preview.port}`;
    const entry = new URL(route.startsWith("/") ? route : `/${route}`, base);
    if (entry.origin !== base) throw new Error("Screenshot routes must remain inside this preview.");
    entry.searchParams.set("previewToken", preview.token);
    const response = await page.goto(entry.href, { waitUntil: "networkidle", timeout: 30000 });
    if (!response || !response.ok()) throw new Error(`Preview route returned HTTP ${response?.status() || "unknown"}.`);
    await fs.mkdir(path.dirname(filename), { recursive: true }); await page.screenshot({ path: filename, fullPage: true });
    return filename;
  } finally { await browser.close(); }
}
