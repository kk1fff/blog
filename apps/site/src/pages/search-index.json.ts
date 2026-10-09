import type { APIRoute } from "astro";
import { listRenderablePosts } from "@agentic-blog/content-contract";

export const GET: APIRoute = async () => {
  const posts = (await listRenderablePosts()).map(({ slug, title, description, tags, publishedAt, body }) => ({ slug, title, description, tags, publishedAt, body }));
  return new Response(JSON.stringify(posts), { headers: { "content-type": "application/json" } });
};
