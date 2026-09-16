import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { allTags, getPost, listPosts, searchPosts, slugify, writePost } from "../packages/content-contract/dist/index.js";

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
