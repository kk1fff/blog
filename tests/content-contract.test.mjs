import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { allTags, getPost, githubPagesWorkflow, listPosts, readSettings, searchPosts, slugify, writePost, writeSettings } from "../packages/content-contract/dist/index.js";

test("managed posts preserve ISO dates and supply searchable metadata", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agentic-blog-test-"));
  await writePost({ slug: "", title: "A Practical Preview", description: "", tags: ["Agent Work", "testing", "agent-work"], publishedAt: "2026-09-16T10:00:00.000Z", draft: false, body: "# Preview\n\nA browser screenshot catches layout errors." }, directory);
  const post = await getPost("a-practical-preview", directory);
  assert.equal(post.publishedAt, "2026-09-16T10:00:00.000Z");
  assert.deepEqual(post.tags, ["agent-work", "testing"]);
  assert.match(post.description, /browser screenshot/);
  const posts = await listPosts(directory);
  assert.deepEqual(allTags(posts), ["agent-work", "testing"]);
  assert.equal(searchPosts(posts, "screenshot").length, 1);
  await fs.rm(directory, { recursive: true, force: true });
});

test("slugify rejects empty structural names", () => {
  assert.equal(slugify("A Title, Again!"), "a-title-again");
  assert.throws(() => slugify("---"), /letter or number/);
});

test("Giscus settings are optional and survive a managed settings round trip", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agentic-blog-settings-"));
  assert.equal((await readSettings(directory)).comments, undefined);
  const settings = await readSettings(directory);
  settings.comments = { giscus: { repo: "kk1fff/blog-content", repoId: "R_kgDOUc8BTw", category: "Announcements", categoryId: "DIC_kwDOUc8BT84DF13p" } };
  await writeSettings(settings, directory);
  assert.deepEqual((await readSettings(directory)).comments, settings.comments);
  await fs.rm(directory, { recursive: true, force: true });
});

test("GitHub Pages workflow uses the pinned engine and Pages artifact actions", () => {
  const workflow = githubPagesWorkflow("main");
  assert.match(workflow, /branches: \["main"\]/);
  assert.match(workflow, /vars\.BLOG_ENGINE_REPOSITORY/);
  assert.match(workflow, /actions\/upload-pages-artifact@v4/);
  assert.match(workflow, /actions\/deploy-pages@v4/);
  assert.match(workflow, /vars\.CLOUDFLARE_WEB_ANALYTICS_TOKEN/);
  assert.doesNotMatch(workflow, /Cloudflare/);
});
