export function normalizeDiscussionPath(value) {
  try {
    const path = value.startsWith("http") ? new URL(value).pathname : value;
    return path.replace(/\/+$/, "") || "/";
  } catch {
    return "";
  }
}

export function discussionCountsByPath(discussions, category) {
  return new Map(discussions
    .filter((discussion) => discussion?.category?.name === category)
    .map((discussion) => [normalizeDiscussionPath(discussion.title), Number(discussion.comments) || 0])
    .filter(([path]) => path));
}

export function commentLabel(count) {
  return `${count} ${count === 1 ? "comment" : "comments"}`;
}

export async function hydrateDiscussionCounts(root = document) {
  const postList = root.querySelector("[data-giscus-repo][data-giscus-category]");
  if (!postList?.dataset.giscusRepo || !postList.dataset.giscusCategory) return;

  try {
    const response = await fetch(`https://api.github.com/repos/${postList.dataset.giscusRepo}/discussions?per_page=100`, {
      headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" }
    });
    if (!response.ok) throw new Error(`GitHub discussions request failed: ${response.status}`);
    const counts = discussionCountsByPath(await response.json(), postList.dataset.giscusCategory);
    root.querySelectorAll("[data-discussion-bar]").forEach((bar) => {
      const count = counts.get(normalizeDiscussionPath(bar.dataset.discussionPath)) || 0;
      const label = commentLabel(count);
      bar.querySelector("[data-discussion-count]").textContent = label;
      bar.setAttribute("aria-label", `${label}; view discussion`);
    });
  } catch {
    // The server-rendered “View discussion” label remains a usable fallback.
  }
}
