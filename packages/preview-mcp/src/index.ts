import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { lifecycleDir, recordPreview, gitCommand, readLifecycle } from "@agentic-blog/content-contract";
import { PreviewServers, stagedPreview, capture, networkAddresses, runPreviewCommand, cancelPreviewBuilds } from "./preview.js";

const root = path.resolve(process.env.AGENTIC_BLOG_ROOT || process.cwd());
const content = path.resolve(process.env.BLOG_CONTENT_DIR || path.join(root, "static_content"));
const work = lifecycleDir(content);
const servers = new PreviewServers();
const server = new McpServer({ name: "agentic-blog-preview", version: "0.3.0" }, { instructions: "open_preview serves the workspace including drafts, or an immutable staged revision on all interfaces and returns clickable URLs, Tailscale first. Keep the server running while the user reviews. render_page(stagedRevisionId,viewport=desktop/phone) records required preview evidence. close_preview revokes one preview; stop_preview_server stops all. Serving ends when this MCP process/connection ends, but saved builds can be reopened." });
import { z } from "zod";
const text = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
function selector(previewId?: string, stagedRevisionId?: string) {
  if (previewId && stagedRevisionId) throw new Error("Select previewId or stagedRevisionId, not both.");
  return previewId || stagedRevisionId;
}
async function workspacePreview(route = "/") {
  const epoch = servers.epoch();
  const id = `local-${randomUUID()}`; const output = path.join(work, "local-builds", id);
  await fs.mkdir(output, { recursive: true });
  const commit = await gitCommand(root, ["rev-parse", "HEAD"]).catch(() => "local");
  await runPreviewCommand("npm", ["run", "build", "-w", "@agentic-blog/site"], root, { ...process.env, BLOG_CONTENT_DIR: content, BLOG_OUTPUT_DIR: output, BLOG_ENGINE_COMMIT: commit, BLOG_PREVIEW_LOCAL: "1" });
  if (servers.epoch() !== epoch) throw new Error("Preview opening was cancelled by shutdown.");
  const preview = await servers.open(id, output, route);
  return { preview, info: servers.info(preview) };
}
server.tool("open_preview", "Open the local workspace including drafts, or an immutable staged revision. Return complete network URLs, including Tailscale addresses.", { stagedRevisionId: z.string().optional() }, async ({ stagedRevisionId }) => text(stagedRevisionId ? (await stagedPreview(content, stagedRevisionId, servers)).info : (await workspacePreview()).info));
server.tool("preview_status", "Report active workspace/staged preview listeners and all interface addresses.", { stagedRevisionId: z.string().optional(), previewId: z.string().optional() }, async ({ stagedRevisionId, previewId }) => {
  const id = selector(previewId, stagedRevisionId);
  const state = await readLifecycle(content);
  return text({ previews: servers.status(id).map(preview => ({ ...preview, revisionId: preview.stagedRevisionId ? state.stages[preview.stagedRevisionId]?.revisionId : undefined, engineCommit: preview.stagedRevisionId ? state.stages[preview.stagedRevisionId]?.engine.commit : undefined })), addresses: networkAddresses(), servingEndsWithMcp: true });
});
server.tool("close_preview", "Close one preview by previewId or stagedRevisionId and revoke its secret link; retain its build.", { stagedRevisionId: z.string().optional(), previewId: z.string().optional() }, async ({ stagedRevisionId, previewId }) => {
  const id = selector(previewId, stagedRevisionId);
  if (!id) throw new Error("Select a previewId or stagedRevisionId to close.");
  return text(await servers.close(id));
});
server.tool("stop_preview_server", "Stop all browser previews without deleting saved builds.", {}, async () => text(await servers.stop()));
server.tool("render_page", "Capture a desktop or phone screenshot. Staged previews record article review evidence; workspace previews include drafts and do not satisfy article approval.", { stagedRevisionId: z.string().optional(), previewId: z.string().optional(), route: z.string().optional(), viewport: z.enum(["desktop", "phone"]).default("desktop") }, async ({ stagedRevisionId, previewId, route, viewport }) => {
  selector(previewId, stagedRevisionId);
  let opened;
  if (previewId) {
    const preview = servers.get(previewId);
    opened = previewId.startsWith("local-")
      ? { preview, info: servers.info(preview) }
      : await stagedPreview(content, previewId, servers);
  } else opened = stagedRevisionId ? await stagedPreview(content, stagedRevisionId, servers) : await workspacePreview(route);
  const { preview, info } = opened;
  const actualRoute = route || preview.route;
  const screenshot = path.join(work, "screenshots", `${randomUUID()}-${viewport}.png`);
  await capture(preview, actualRoute, viewport, screenshot);
  if (info.stagedRevisionId) await recordPreview(content, info.stagedRevisionId, viewport, actualRoute, screenshot);
  return { content: [{ type: "text" as const, text: JSON.stringify({ ...info, route: actualRoute, viewport, screenshot, contentDir: content }) }, { type: "image" as const, data: (await fs.readFile(screenshot)).toString("base64"), mimeType: "image/png" }] };
});
const transport = new StdioServerTransport();
let shutdown: Promise<void> | undefined;
const stop = () => { cancelPreviewBuilds(); return shutdown ||= servers.dispose().then(() => undefined); };
server.server.onclose = () => { void stop(); };
process.stdin.on("end", () => { void stop().then(() => transport.close()); });
process.stdin.on("close", () => { void stop(); });
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { void stop().finally(() => process.exit(0)); });
await server.connect(transport);
