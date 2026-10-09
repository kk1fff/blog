import assert from 'node:assert/strict';
import test from 'node:test';
import { GithubPagesProvider } from '../packages/content-mcp/dist/publishing.js';
import { hash } from '../packages/content-contract/dist/index.js';
const publication = () => ({ id: 'publication', slug: 'article', revisionId: 'revision', files: { 'assets/image.png': hash('image') }, mode: 'push', step: 'submitted', status: 'publishing', commit: 'a'.repeat(40), branch: 'main', message: 'Reviewed article', context: { repository: 'test/content', productionBranch: 'main', engine: { repository: 'test/engine', commit: 'b'.repeat(40) } } });

test('GitHub inspection filters the managed workflow by exact commit and accepts only deployment events', async () => {
  const calls = [];
  const provider = new GithubPagesProvider(async args => {
    calls.push(args); return JSON.stringify({ workflow_runs: [
      { id: 999, event: 'pull_request', status: 'completed', conclusion: 'success' },
      { id: 2, event: 'push', status: 'completed', conclusion: 'success', run_attempt: 1, html_url: 'https://github.com/run/2' },
      { id: 1, event: 'push', status: 'completed', conclusion: 'failure', run_attempt: 1 }
    ] });
  });
  const result = await provider.inspect(publication());
  assert.match(calls[0][1], /workflows\/deploy.yml\/runs\?head_sha=a{40}&branch=main/);
  assert.equal(result.runId, 2); assert.equal(result.step, 'deployed'); assert.equal(result.status, 'publishing');
});

test('GitHub PR inspection distinguishes awaiting merge, closed PR, and deployment of the merge commit', async () => {
  let pr = { merged: false, state: 'open' }; const calls = [];
  const provider = new GithubPagesProvider(async args => { calls.push(args); return JSON.stringify(args[1].includes('/pulls/') ? pr : { workflow_runs: [] }); });
  const pub = { ...publication(), mode: 'pr', prNumber: 4 };
  assert.equal((await provider.inspect(pub)).status, 'awaiting_merge');
  pr = { merged: false, state: 'closed' }; assert.equal((await provider.inspect(pub)).recoverable, false);
  pr = { merged: true, merge_commit_sha: 'c'.repeat(40) }; const merged = await provider.inspect(pub);
  assert.equal(merged.mergeCommit, 'c'.repeat(40)); assert.match(calls.at(-1)[1], /head_sha=c{40}/);
});

test('lost PR submission responses reuse the existing PR', async () => {
  const calls = [];
  const provider = new GithubPagesProvider(async args => { calls.push(args); return JSON.stringify([{ number: 7, url: 'https://github.com/test/content/pull/7', state: 'OPEN' }]); });
  const result = await provider.submit({ ...publication(), mode: 'pr' });
  assert.equal(result.prNumber, 7); assert.equal(calls.length, 1); assert.equal(calls[0][1], 'list');
});

test('rerun recovery inspects run attempts before submitting another rerun', async () => {
  const calls = []; let attempt = 1;
  const provider = new GithubPagesProvider(async args => { calls.push(args); return args[1].endsWith('/rerun') ? '' : JSON.stringify({ status: 'completed', conclusion: 'failure', run_attempt: attempt }); });
  const pub = { ...publication(), recoverable: true, runId: 3, runAttempt: 1 };
  await provider.retry(pub); assert.equal(calls.filter(args => args[1].endsWith('/rerun')).length, 1);
  attempt = 2; await provider.retry(pub); assert.equal(calls.filter(args => args[1].endsWith('/rerun')).length, 1);
});

test('live verification checks publication, engine, HTML revision and asset bytes with cache busting', async () => {
  let asset = 'image'; const urls = []; const pub = publication();
  const provider = new GithubPagesProvider(async () => JSON.stringify({ html_url: 'https://test.example/' }), async url => {
    urls.push(String(url));
    const pathname = new URL(url).pathname;
    if (pathname === '/publication-manifest.json') return new Response(JSON.stringify({ publicationId: pub.id, engine: pub.context.engine, articleRevisions: { article: 'revision' } }));
    if (pathname === '/posts/article/') return new Response('<meta name="agentic-blog-revision" content="revision">');
    return new Response(asset);
  });
  const result = await provider.verify(pub); assert.equal(result.url, 'https://test.example/posts/article/');
  assert.ok(urls.every(url => url.includes('publication=publication')));
  asset = 'wrong bytes'; await assert.rejects(provider.verify(pub), /Live asset differs/);
});

test('stale publication markers never become verified live', async () => {
  const provider = new GithubPagesProvider(async () => JSON.stringify({ html_url: 'https://test.example/' }), async () => new Response(JSON.stringify({ publicationId: 'old', engine: { commit: 'old' } })));
  await assert.rejects(provider.verify(publication()), /marker differs/);
});
