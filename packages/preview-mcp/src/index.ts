import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { chromium } from "playwright";
import { z } from "zod";

const root = path.resolve(process.env.AGENTIC_BLOG_ROOT || process.cwd());
const content = path.resolve(process.env.BLOG_CONTENT_DIR || path.join(root, "static_content"));
const work = path.join(root, ".agentic-blog", "preview");
const mime: Record<string, string> = { ".html":"text/html", ".css":"text/css", ".js":"text/javascript", ".json":"application/json", ".png":"image/png", ".jpg":"image/jpeg", ".jpeg":"image/jpeg", ".svg":"image/svg+xml", ".ico":"image/x-icon", ".webp":"image/webp" };
const run = (command: string, args: string[], env: NodeJS.ProcessEnv) => new Promise<void>((resolve, reject) => {
  const child = spawn(command, args, { cwd: root, env, stdio: "pipe" });
  let output = "";
  child.stdout.on("data", (data) => output += data);
  child.stderr.on("data", (data) => output += data);
  child.on("close", (code) => code === 0 ? resolve() : reject(new Error(output)));
});
async function serve(directory: string) {
  const server = http.createServer(async (req, res) => { try { const requested = decodeURIComponent(new URL(req.url || "/", "http://localhost").pathname); let target = path.resolve(directory, `.${requested}`); if (!target.startsWith(directory)) throw new Error("Bad path"); try { const stat = await fs.stat(target); if (stat.isDirectory()) target = path.join(target, "index.html"); } catch { target = path.join(target, "index.html"); } const data = await fs.readFile(target); res.writeHead(200, { "content-type": mime[path.extname(target)] || "application/octet-stream" }); res.end(data); } catch { res.writeHead(404); res.end("Not found"); } });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); if (!address || typeof address === "string") throw new Error("Could not start preview server."); return { server, url: `http://127.0.0.1:${address.port}` };
}
const server = new McpServer({ name: "agentic-blog-preview", version: "0.1.0" });
server.tool("render_page", "Build the current content as production static HTML and return a browser screenshot.", { route: z.string().default("/"), viewport: z.enum(["desktop", "phone"]).default("desktop") }, async ({ route, viewport }) => {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-"); const output = path.join(work, "build", stamp); const screenshots = path.join(work, "screenshots"); await fs.mkdir(screenshots, { recursive: true });
  await run("npm", ["run", "build", "-w", "@agentic-blog/site"], { ...process.env, BLOG_CONTENT_DIR: content, BLOG_OUTPUT_DIR: output });
  const local = await serve(output); try { const browser = await chromium.launch({ headless: true }); const page = await browser.newPage({ viewport: viewport === "desktop" ? { width: 1280, height: 800 } : { width: 390, height: 844 }, deviceScaleFactor: 1 }); const url = `${local.url}${route.startsWith("/") ? route : `/${route}`}`; await page.goto(url, { waitUntil: "networkidle" }); const screenshot = path.join(screenshots, `${stamp}-${viewport}.png`); await page.screenshot({ path: screenshot, fullPage: true }); await browser.close(); const data = await fs.readFile(screenshot); return { content: [{ type: "text", text: JSON.stringify({ route, viewport, url, screenshot, contentDir: content }) }, { type: "image", data: data.toString("base64"), mimeType: "image/png" }] }; } finally { local.server.close(); }
});
await server.connect(new StdioServerTransport());
