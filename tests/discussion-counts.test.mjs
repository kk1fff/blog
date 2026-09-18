import assert from "node:assert/strict";
import test from "node:test";
import { commentLabel, discussionCountsByPath, normalizeDiscussionPath } from "../apps/site/src/scripts/discussion-counts.mjs";

test("discussion counts match Giscus pathname discussions in the configured category", () => {
  const counts = discussionCountsByPath([
    { title: "/posts/welcome", comments: 2, category: { name: "Announcements" } },
    { title: "/posts/ignore-me", comments: 9, category: { name: "General" } },
    { title: "/posts/zero", comments: 0, category: { name: "Announcements" } }
  ], "Announcements");
  assert.equal(counts.get("/posts/welcome"), 2);
  assert.equal(counts.get("/posts/zero"), 0);
  assert.equal(counts.has("/posts/ignore-me"), false);
});

test("discussion labels and paths handle singular, plural, and trailing slashes", () => {
  assert.equal(normalizeDiscussionPath("/posts/welcome/"), "/posts/welcome");
  assert.equal(commentLabel(1), "1 comment");
  assert.equal(commentLabel(0), "0 comments");
});
