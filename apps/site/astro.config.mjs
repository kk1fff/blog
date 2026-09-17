import { defineConfig } from "astro/config";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const content = path.resolve(process.env.BLOG_CONTENT_DIR || path.join(process.cwd(), "static_content"));
export default defineConfig({
  output: "static",
  outDir: process.env.BLOG_OUTPUT_DIR || "./dist",
  integrations: [{
    name: "copy-content-assets",
    hooks: {
      "astro:build:done": async ({ dir }) => {
        try { await fs.cp(path.join(content, "assets"), path.join(fileURLToPath(dir), "assets"), { recursive: true }); }
        catch (error) { if (error?.code !== "ENOENT") throw error; }
      }
    }
  }]
});
