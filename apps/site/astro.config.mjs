import { defineConfig } from "astro/config";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildPublicationManifest } from "@agentic-blog/content-contract";

const content = path.resolve(process.env.BLOG_CONTENT_DIR || path.join(process.cwd(), "static_content"));
export default defineConfig({
  output: "static",
  outDir: process.env.BLOG_OUTPUT_DIR || "./dist",
  integrations: [{
    name: "copy-content-assets",
    hooks: {
      "astro:config:setup": ({ command }) => {
        if (command === "dev") process.env.BLOG_PREVIEW_LOCAL = "1";
      },
      "astro:build:done": async ({ dir }) => {
        try { await fs.cp(path.join(content, "assets"), path.join(fileURLToPath(dir), "assets"), { recursive: true }); }
        catch (error) { if (error?.code !== "ENOENT") throw error; }
        await fs.writeFile(path.join(fileURLToPath(dir), "publication-manifest.json"), JSON.stringify(await buildPublicationManifest(content)));
      }
    }
  }]
});
