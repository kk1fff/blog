import type { APIRoute } from "astro";
import { listPosts } from "@agentic-blog/content-contract";

export const GET: APIRoute = async () => {
  const posts = (await listPosts()).map(({ slug, title, description, tags, publishedAt, body }) => ({ slug, title, description, tags, publishedAt, body }));
  return new Response(JSON.stringify(posts), { headers: { "content-type": "application/json" } });
};
