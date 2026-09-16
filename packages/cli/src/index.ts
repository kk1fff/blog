#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = path.resolve(process.env.AGENTIC_BLOG_ROOT || process.cwd());
const content = path.resolve(process.env.BLOG_CONTENT_DIR || path.join(root, "static_content"));
const template = path.join(root, "templates", "content-starter");
const hash = Buffer.from(root).toString("base64url").slice(-10).toLowerCase();
const arg = (name: string) => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; };
async function exists(file: string) { try { await fs.access(file); return true; } catch { return false; } }
async function command(commandName: string, args: string[]) { return exec(commandName, args, { cwd: root }); }
async function ensureMcp() {
  const contentName = `agentic-blog-content-${hash}`;
  const previewName = `agentic-blog-preview-${hash}`;
  for (const [name, entry] of [[contentName, "packages/content-mcp/dist/index.js"], [previewName, "packages/preview-mcp/dist/index.js"]] as const) {
    try { await command("codex", ["mcp", "remove", name]); } catch { /* first install */ }
    await command("codex", ["mcp", "add", name, "--env", `AGENTIC_BLOG_ROOT=${root}`, "--env", `BLOG_CONTENT_DIR=${content}`, "--", "node", path.join(root, entry)]);
  }
  return { contentName, previewName };
}
async function installSkills() {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const skillsHome = path.join(codexHome, "skills");
  await fs.mkdir(skillsHome, { recursive: true });
  const installed: string[] = [];
  for (const name of ["agentic-blog-setup", "agentic-blog-content"]) {
    const source = path.join(root, "skills", name);
    const destination = path.join(skillsHome, name);
    try {
      const entry = await fs.lstat(destination);
      if (!entry.isSymbolicLink()) throw new Error(`Codex skill '${name}' already exists at ${destination}; refusing to replace it.`);
      if (await fs.realpath(destination) !== await fs.realpath(source)) throw new Error(`Codex skill '${name}' points to another project; refusing to replace it.`);
    } catch (error: any) {
      if (error.code !== "ENOENT") throw error;
      await fs.symlink(source, destination, "dir");
    }
    installed.push(destination);
  }
  return installed;
}
async function setup() {
  await fs.mkdir(path.join(root, ".agentic-blog"), { recursive: true });
  const createdContent = !(await exists(content));
  if (createdContent) {
    await fs.cp(template, content, { recursive: true });
    await command("git", ["init", "-b", "main", content]);
  }
  await command("npx", ["playwright", "install", "chromium"]);
  const skills = await installSkills();
  const mcp = await ensureMcp();
  console.log(JSON.stringify({ root, content, createdContent, skills, mcp, next: "Restart Codex, then use $agentic-blog-setup to finish GitHub and Cloudflare configuration." }, null, 2));
}
async function doctor() {
  const report: Record<string, unknown> = { root, content, contentRepository: await exists(path.join(content, ".git")), blogSettings: await exists(path.join(content, "blog.yaml")), packagesBuilt: await exists(path.join(root, "packages/content-mcp/dist/index.js")) };
  for (const executable of ["git", "node", "npm", "codex", "gh", "wrangler"]) { try { const { stdout } = await command(executable, ["--version"]); report[executable] = stdout.trim().split("\n")[0]; } catch { report[executable] = "missing"; } }
  console.log(JSON.stringify(report, null, 2));
}
const operation = process.argv[2] || "doctor";
if (operation === "setup") await setup(); else if (operation === "doctor") await doctor(); else { console.error(`Unknown command: ${operation}`); process.exitCode = 1; }
