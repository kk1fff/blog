import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import test, { after } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  writePost, getPost, listPosts, readSettings, writeSettings, stageArticle, getStage,
  approveArticle, recordPreview, articleLifecycle, pendingLifecycle, readLifecycle,
  stageDirectory, readManagedFile, verifyStageFiles, buildPublicationManifest,
  lifecycleDir, withFileLock, hash, renderedRevision
} from '../packages/content-contract/dist/index.js';
import { publish, refreshPublication, fetchProduction, githubRepository } from '../packages/content-mcp/dist/publishing.js';
const exec = promisify(execFile);
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-lifecycle-'));
process.env.AGENTIC_BLOG_ROOT = root;
after(() => fs.rm(root, { recursive: true, force: true }));
let sequence = 0;
async function git(dir, ...args) { return (await exec('git', args, { cwd: dir })).stdout.trim(); }
const article = (slug, overrides = {}) => ({ slug, title: slug, description: slug, tags: [], publishedAt: '2026-10-09T00:00:00.000Z', draft: false, body: 'Original article', ...overrides });
async function fixture() {
  const base = path.join(root, String(++sequence)); const dir = path.join(base, 'content'); const remote = path.join(base, 'remote.git');
  await fs.mkdir(dir, { recursive: true });
  await git(base, 'init', '--bare', remote); await git(dir, 'init', '-b', 'main');
  await git(dir, 'config', 'user.email', 'test@example.com'); await git(dir, 'config', 'user.name', 'Test');
  await fs.mkdir(path.join(dir, 'assets')); await fs.writeFile(path.join(dir, 'assets', 'shared.svg'), '<svg>original</svg>');
  await writePost(article('live', { body: '![Shared](/assets/shared.svg)' }), dir);
  const settings = await readSettings(dir); settings.githubPages = { productionBranch: 'main' }; settings.hosting = 'github-pages'; settings.publishing.mode = 'push'; await writeSettings(settings, dir);
  await git(dir, 'add', '-A'); await git(dir, 'commit', '-m', 'baseline'); await git(dir, 'remote', 'add', 'origin', remote); await git(dir, 'push', 'origin', 'main');
  let inspectResult = { step: 'deployed', status: 'publishing' }; let verified = true; let submits = 0; let retries = 0;
  const provider = {
    async context() { return { provider: 'github-pages', repository: 'test/content', remote, productionBranch: 'main', baseCommit: await fetchProduction(dir, remote, 'main'), engine: { repository: 'test/engine', commit: 'a'.repeat(40) }, buildEnvironment: {} }; },
    async submit(pub) { submits++; return pub.mode === 'pr' ? { step: 'submitted', status: 'awaiting_merge', prUrl: 'https://github.com/test/content/pull/1', prNumber: 1 } : { step: 'submitted', status: 'publishing' }; },
    async inspect() { return inspectResult; },
    async retry() { retries++; return { status: 'publishing', step: 'submitted', error: undefined }; },
    async verify(pub) { if (!verified) throw new Error('Stale live revision'); return `https://test.example/posts/${pub.slug}/`; }
  };
  return { dir, remote, provider, setInspect: value => inspectResult = value, setVerified: value => verified = value, submits: () => submits, retries: () => retries };
}
async function draft(f, slug = 'new', body = '![Image](/assets/new.png)') {
  await fs.writeFile(path.join(f.dir, 'assets', 'new.png'), 'asset bytes');
  await writePost(article(slug, { draft: true, body }), f.dir);
  await articleLifecycle(f.dir, slug, true);
  return stageArticle(f.dir, slug, await f.provider.context());
}
async function reviewed(f, stage) {
  for (const viewport of ['desktop', 'phone']) {
    const file = path.join(root, `${stage.id}-${viewport}.png`); await fs.writeFile(file, 'screenshot evidence');
    await recordPreview(f.dir, stage.id, viewport, `/posts/${stage.slug}/`, file);
  }
  await approveArticle(f.dir, stage.id);
}

test('staging includes exactly the article and dependencies without changing working draft or unrelated content', async () => {
  const f = await fixture(); await writePost(article('other-draft', { draft: true }), f.dir);
  const stage = await draft(f);
  assert.equal((await getPost('new', f.dir)).draft, true);
  assert.deepEqual(Object.keys(stage.files).sort(), ['assets/new.png', 'posts/new.md']);
  const content = path.join(stageDirectory(f.dir, stage.id), 'content');
  assert.equal((await getPost('new', content)).draft, false);
  assert.equal(await getPost('other-draft', content), undefined);
  assert.ok(await getPost('live', content));
  assert.equal((await stageArticle(f.dir, 'new', await f.provider.context())).id, stage.id);
  assert.equal(await git(f.remote, 'rev-parse', 'main'), stage.baseCommit);
});

test('approval requires both article-route viewports, and content edits require new approval', async () => {
  const f = await fixture(); const stage = await draft(f);
  await assert.rejects(approveArticle(f.dir, stage.id), /Desktop and phone/);
  const file = path.join(root, 'wrong-route.png'); await fs.writeFile(file, 'image');
  await recordPreview(f.dir, stage.id, 'desktop', '/', file);
  assert.equal((await getStage(f.dir, stage.id)).previews.desktop, undefined);
  await reviewed(f, stage);
  assert.equal((await articleLifecycle(f.dir, 'new')).status, 'draft');
  assert.equal((await articleLifecycle(f.dir, 'new')).publishing.status, 'ready_to_publish');
  const post = await getPost('new', f.dir); await writePost({ ...post, body: post.body + '\nChanged' }, f.dir);
  assert.equal((await articleLifecycle(f.dir, 'new')).status, 'draft');
  await assert.rejects(approveArticle(f.dir, stage.id), /stale/);
  await assert.rejects(publish(f.dir, { stagedRevisionId: stage.id, message: 'publish' }, f.provider), /current approved/);
});

test('asset changes invalidate approval; missing dependencies surface recoverable state', async () => {
  const f = await fixture(); const stage = await draft(f); await reviewed(f, stage);
  await fs.writeFile(path.join(f.dir, 'assets', 'new.png'), 'changed');
  assert.equal((await articleLifecycle(f.dir, 'new')).status, 'draft');
  await fs.rm(path.join(f.dir, 'assets', 'new.png'));
  const status = await articleLifecycle(f.dir, 'new'); assert.equal(status.status, 'draft'); assert.equal(status.publishing.status, 'failed'); assert.match(status.publishing.error, /ENOENT/);
});

test('shared assets and missing local assets cannot be staged', async () => {
  const f = await fixture(); await writePost(article('new', { draft: true, body: '![Shared](/assets/shared.svg)' }), f.dir);
  await fs.writeFile(path.join(f.dir, 'assets', 'shared.svg'), 'new bytes');
  await assert.rejects(stageArticle(f.dir, 'new', await f.provider.context()), /Shared asset/);
  await writePost(article('new', { body: '![Missing](/assets/missing.png)' }), f.dir);
  await assert.rejects(stageArticle(f.dir, 'new', await f.provider.context()), /ENOENT/);
});

test('snapshot integrity covers baseline settings and added files, not only article bytes', async () => {
  const f = await fixture(); const stage = await draft(f);
  const content = path.join(stageDirectory(f.dir, stage.id), 'content');
  await fs.writeFile(path.join(content, 'blog.yaml'), 'title: changed');
  await assert.rejects(verifyStageFiles(f.dir, stage), /snapshot changed/);
});

test('publication selects reviewed bytes and leaves branch, index, drafts and local settings intact', async () => {
  const f = await fixture(); const stage = await draft(f); await reviewed(f, stage);
  await writePost(article('other', { draft: true }), f.dir);
  await fs.writeFile(path.join(f.dir, 'unrelated.txt'), 'unfinished'); await git(f.dir, 'add', 'unrelated.txt');
  const settings = await readSettings(f.dir); settings.site.title = 'Unreviewed title'; await writeSettings(settings, f.dir);
  const before = await git(f.dir, 'status', '--porcelain');
  const pub = await publish(f.dir, { stagedRevisionId: stage.id, message: 'Reviewed article' }, f.provider);
  assert.equal(pub.step, 'submitted'); assert.equal(pub.status, 'publishing');
  assert.equal(await git(f.dir, 'status', '--porcelain'), before); assert.equal(await git(f.dir, 'branch', '--show-current'), 'main');
  assert.equal(await git(f.remote, 'show', 'main:assets/new.png'), 'asset bytes');
  await assert.rejects(git(f.remote, 'show', 'main:posts/other.md'));
  assert.doesNotMatch(await git(f.remote, 'show', 'main:blog.yaml'), /Unreviewed title/);
  await assert.rejects(git(f.remote, 'show', 'main:unrelated.txt'));
  const result = await refreshPublication(f.dir, pub.id, f.provider); assert.equal(result.status, 'succeeded');
  assert.equal((await articleLifecycle(f.dir, 'new')).liveRevisionId, stage.revisionId);
  const repeat = await publish(f.dir, { stagedRevisionId: stage.id, message: 'Retry' }, f.provider);
  assert.equal(repeat.id, pub.id); assert.equal(f.submits(), 1);
});

test('published updates retain live revision while the next revision awaits review', async () => {
  const f = await fixture(); const stage = await draft(f); await reviewed(f, stage);
  const pub = await publish(f.dir, { stagedRevisionId: stage.id, message: 'first' }, f.provider); await refreshPublication(f.dir, pub.id, f.provider);
  const post = await getPost('new', f.dir); await writePost({ ...post, body: 'Second version' }, f.dir);
  const next = await stageArticle(f.dir, 'new', await f.provider.context());
  const status = await articleLifecycle(f.dir, 'new');
  assert.equal(status.liveRevisionId, stage.revisionId); assert.notEqual(status.revisionId, stage.revisionId); assert.equal(status.status, 'published'); assert.equal(status.publishing.status, 'staged'); assert.equal(status.hasPendingChanges, true);
  assert.equal(next.slug, stage.slug);
});

test('live verification failures keep deployment pending, and later status refresh completes it', async () => {
  const f = await fixture(); const stage = await draft(f); await reviewed(f, stage);
  const pub = await publish(f.dir, { stagedRevisionId: stage.id, message: 'publish' }, f.provider);
  f.setVerified(false); const pending = await refreshPublication(f.dir, pub.id, f.provider);
  assert.equal(pending.status, 'publishing'); assert.match(pending.error, /Stale live/);
  f.setVerified(true); assert.equal((await refreshPublication(f.dir, pub.id, f.provider)).status, 'succeeded');
});

test('deployment failure retries the same operation and commit', async () => {
  const f = await fixture(); const stage = await draft(f); await reviewed(f, stage);
  const pub = await publish(f.dir, { stagedRevisionId: stage.id, message: 'publish' }, f.provider);
  f.setInspect({ status: 'failed', error: 'build failed', recoverable: true, runId: 123 });
  assert.equal((await refreshPublication(f.dir, pub.id, f.provider)).status, 'failed');
  const retried = await publish(f.dir, { stagedRevisionId: stage.id, message: 'retry' }, f.provider);
  assert.equal(retried.id, pub.id); assert.equal(retried.commit, pub.commit); assert.equal(f.retries(), 1); assert.equal(f.submits(), 1);
});

test('another active publication blocks submission and a changed production baseline invalidates staging', async () => {
  const f = await fixture(); const stage = await draft(f); await reviewed(f, stage);
  await fs.writeFile(path.join(f.dir, 'external.txt'), 'external'); await git(f.dir, 'add', 'external.txt'); await git(f.dir, 'commit', '-m', 'external'); await git(f.dir, 'push', 'origin', 'main');
  await assert.rejects(publish(f.dir, { stagedRevisionId: stage.id, message: 'publish' }, f.provider), /baseline/);
  const next = await stageArticle(f.dir, 'new', await f.provider.context()); await reviewed(f, next);
  await publish(f.dir, { stagedRevisionId: next.id, message: 'publish' }, f.provider);
  const second = await draft(f, 'second'); await reviewed(f, second);
  await assert.rejects(publish(f.dir, { stagedRevisionId: second.id, message: 'second' }, f.provider), /still active/);
});

test('PR delivery stays awaiting merge; closure is a terminal failure', async () => {
  const f = await fixture(); const stage = await draft(f); await reviewed(f, stage);
  const pub = await publish(f.dir, { stagedRevisionId: stage.id, message: 'PR', mode: 'pr' }, f.provider);
  assert.equal(pub.status, 'awaiting_merge');
  f.setInspect({ status: 'awaiting_merge' }); assert.equal((await refreshPublication(f.dir, pub.id, f.provider)).status, 'awaiting_merge');
  f.setInspect({ status: 'failed', error: 'PR closed', recoverable: false }); assert.equal((await refreshPublication(f.dir, pub.id, f.provider)).status, 'failed');
  await assert.rejects(publish(f.dir, { stagedRevisionId: stage.id, message: 'retry' }, f.provider), /PR closed/);
});

test('publication metadata proves engine, article and asset identity', async () => {
  const f = await fixture(); const stage = await draft(f);
  const content = path.join(stageDirectory(f.dir, stage.id), 'content');
  const manifest = await buildPublicationManifest(content, stage.engine.commit, false);
  assert.equal(manifest.articleRevisions.new, stage.revisionId); assert.equal(await renderedRevision('new', content), stage.revisionId);
  await assert.rejects(buildPublicationManifest(content, 'b'.repeat(40), false), /engine pin/);
  await fs.writeFile(path.join(content, 'assets', 'new.png'), 'tampered');
  await assert.rejects(buildPublicationManifest(content, stage.engine.commit, false), /input changed/);
});

test('explicit setup paths do not implicitly include posts, assets, or staged files', async () => {
  const f = await fixture();
  await assert.rejects(publish(f.dir, { message: 'everything' }, f.provider), /Unrestricted/);
  await assert.rejects(publish(f.dir, { paths: ['posts/live.md'], message: 'article bypass' }, f.provider), /require an approved/);
  await assert.rejects(publish(f.dir, { paths: ['assets/shared.svg'], message: 'asset bypass' }, f.provider), /require an approved/);
  const pub = await publish(f.dir, { paths: ['blog.yaml'], message: 'settings' }, f.provider);
  assert.ok(pub.id); assert.equal(pub.slug, undefined);
});

test('pending lifecycle discovers existing content without asserting legacy live verification', async () => {
  const f = await fixture(); await draft(f);
  const records = await pendingLifecycle(f.dir);
  assert.equal(records.find(item => item.slug === 'live').status, 'published');
  assert.equal(records.find(item => item.slug === 'live').liveVerification, 'unknown');
  assert.equal(records.find(item => item.slug === 'new').nextAction, 'preview');
  const state = await readLifecycle(f.dir); assert.equal(state.version, 2);
});

test('symlink assets and encoded traversal are rejected', async () => {
  const f = await fixture(); await fs.symlink(path.join(root, 'outside'), path.join(f.dir, 'assets', 'escape'));
  await assert.rejects(readManagedFile(f.dir, 'assets/../blog.yaml'), /Unsafe/);
  await assert.rejects(readManagedFile(f.dir, 'assets/escape/file'));
});

test('abandoned process locks recover, and live process locks serialize', async () => {
  const f = await fixture(); const lock = path.join(lifecycleDir(f.dir), 'test.lock');
  await fs.mkdir(lock, { recursive: true }); await fs.writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: 2147483647, token: 'dead' }));
  assert.equal(await withFileLock(lock, async () => 42), 42);
  const events = [];
  await Promise.all([withFileLock(lock, async () => { events.push('first'); await new Promise(resolve => setTimeout(resolve, 80)); events.push('done'); }), withFileLock(lock, async () => { events.push('second'); })]);
  assert.deepEqual(events, ['first', 'done', 'second']);
});

test('GitHub origin parsing supports HTTPS and SSH without silently accepting another provider', () => {
  for (const remote of ['https://github.com/test/content.git', 'git@github.com:test/content.git', 'ssh://git@github.com/test/content.git']) assert.equal(githubRepository(remote), 'test/content');
  assert.throws(() => githubRepository('https://example.com/test/content.git'), /github.com/);
});

test('lost commit and push checkpoints resume the same commit without another submission', async () => {
  const f = await fixture(); const stage = await draft(f); await reviewed(f, stage);
  const pub = await publish(f.dir, { stagedRevisionId: stage.id, message: 'recover' }, f.provider);
  const { mutateLifecycle } = await import('../packages/content-contract/dist/index.js');
  await mutateLifecycle(f.dir, async state => { state.publications[pub.id].step = 'prepared'; state.publications[pub.id].commit = undefined; });
  const resumed = await publish(f.dir, { publicationId: pub.id, message: 'resume' }, f.provider);
  assert.equal(resumed.commit, pub.commit); assert.equal(resumed.id, pub.id);
  assert.equal(await git(f.remote, 'rev-list', '--count', 'main'), '2');
});

test('a later edit can coexist with an already submitted publication', async () => {
  const f = await fixture(); const stage = await draft(f); await reviewed(f, stage);
  const pub = await publish(f.dir, { stagedRevisionId: stage.id, message: 'submit' }, f.provider);
  const post = await getPost('new', f.dir); await writePost({ ...post, body: 'Next working version' }, f.dir);
  await refreshPublication(f.dir, pub.id, f.provider);
  const record = await articleLifecycle(f.dir, 'new');
  assert.equal(record.status, 'published'); assert.equal(record.hasPendingChanges, true); assert.equal(record.liveRevisionId, stage.revisionId);
});

test('a changed engine pin invalidates an approved stage', async () => {
  const f = await fixture(); const stage = await draft(f); await reviewed(f, stage);
  const original = f.provider.context;
  f.provider.context = async () => ({ ...await original(), engine: { repository: 'test/engine', commit: 'b'.repeat(40) } });
  await assert.rejects(publish(f.dir, { stagedRevisionId: stage.id, message: 'wrong engine' }, f.provider), /engine pin changed/);
});

test('CSS dependencies are captured while external asset URLs are excluded', async () => {
  const f = await fixture();
  await fs.writeFile(path.join(f.dir, 'assets', 'style.css'), 'body { background:url(background.png); }');
  await fs.writeFile(path.join(f.dir, 'assets', 'background.png'), 'background');
  const stage = await draft(f, 'css', '<link href="/assets/style.css"><img src="https://cdn.example.com/assets/external.png">');
  assert.deepEqual(stage.assetPaths, ['assets/background.png', 'assets/style.css']);
});

test('corrupted snapshot staging recovers without retaining previous approval or preview evidence', async () => {
  const f = await fixture(); const stage = await draft(f); await reviewed(f, stage);
  const content = path.join(stageDirectory(f.dir, stage.id), 'content'); await fs.writeFile(path.join(content, 'injected.txt'), 'tampered');
  const restored = await stageArticle(f.dir, 'new', await f.provider.context());
  assert.equal(restored.id, stage.id); assert.equal(restored.status, 'draft'); assert.equal(restored.publishing.status, 'staged'); assert.deepEqual(restored.previews, {}); assert.equal(restored.approvedAt, undefined);
  await verifyStageFiles(f.dir, restored);
});

test('explicit dependencies persist through subsequent staging without respecifying them', async () => {
  const f = await fixture(); await writePost(article('extra', { draft: true }), f.dir);
  await fs.writeFile(path.join(f.dir, 'assets', 'extra.json'), '{}');
  const first = await stageArticle(f.dir, 'extra', await f.provider.context(), ['assets/extra.json']);
  const next = await stageArticle(f.dir, 'extra', await f.provider.context());
  assert.equal(next.id, first.id); assert.deepEqual((await articleLifecycle(f.dir, 'extra')).assetPaths, ['assets/extra.json']);
});

test('publication build rejects changed production context and captured environment', async () => {
  const f = await fixture(); const stage = await draft(f); const content = path.join(stageDirectory(f.dir, stage.id), 'content');
  await fs.writeFile(path.join(content, 'blog.yaml'), 'site:\n  title: different\n');
  await assert.rejects(buildPublicationManifest(content, stage.engine.commit, false), /production context/);
  const inputPath = path.join(content, '.agentic-publication.json'); const input = JSON.parse(await fs.readFile(inputPath)); input.buildEnvironment.PUBLIC_CLOUDFLARE_WEB_ANALYTICS_TOKEN = 'reviewed-token'; await fs.writeFile(inputPath, JSON.stringify(input));
  await assert.rejects(buildPublicationManifest(content, stage.engine.commit, false), /build environment changed/);
});

test('article availability stays separate from approval, submission, failure, and successful verification', async () => {
  const f = await fixture(); const stage = await draft(f);
  let record = await articleLifecycle(f.dir, 'new');
  assert.equal(record.status, 'draft'); assert.equal(record.publishing.status, 'staged');
  await reviewed(f, stage);
  assert.equal((await articleLifecycle(f.dir, 'new')).status, 'draft');
  const pub = await publish(f.dir, { stagedRevisionId: stage.id, message: 'publish' }, f.provider);
  assert.equal((await articleLifecycle(f.dir, 'new')).status, 'draft');
  await refreshPublication(f.dir, pub.id, f.provider);
  record = await articleLifecycle(f.dir, 'new');
  assert.equal(record.status, 'published'); assert.equal(record.hasPendingChanges, false);
  assert.equal(record.liveVerification, 'verified'); assert.equal(record.publishing.status, 'succeeded');
  const post = await getPost('new', f.dir);
  await writePost({ ...post, body: 'Unpublished changes' }, f.dir);
  const update = await stageArticle(f.dir, 'new', await f.provider.context()); await reviewed(f, update);
  const nextPub = await publish(f.dir, { stagedRevisionId: update.id, message: 'update' }, f.provider);
  f.setInspect({ status: 'failed', error: 'deployment failed', recoverable: true });
  await refreshPublication(f.dir, nextPub.id, f.provider);
  record = await articleLifecycle(f.dir, 'new');
  assert.equal(record.status, 'published'); assert.equal(record.hasPendingChanges, true);
  assert.equal(record.publishing.status, 'failed'); assert.equal(record.liveRevisionId, stage.revisionId);
});

test('version 1 migration preserves approvals, snapshots, publication history, and edited public availability', async () => {
  const f = await fixture(); const stage = await draft(f); await reviewed(f, stage);
  const pub = await publish(f.dir, { stagedRevisionId: stage.id, message: 'publish' }, f.provider);
  await refreshPublication(f.dir, pub.id, f.provider);
  const state = await readLifecycle(f.dir);
  state.version = 1;
  state.articles.new.status = 'ready_to_publish';
  state.publications[pub.id].status = 'published';
  delete state.articles.new.publishing;
  state.articles.legacy = { slug: 'legacy', revisionId: 'legacy-version', assetPaths: [], status: 'unverified', updatedAt: new Date().toISOString() };
  await fs.writeFile(path.join(lifecycleDir(f.dir), 'state.json'), JSON.stringify(state));
  const migrated = await readLifecycle(f.dir);
  assert.equal(migrated.version, 2); assert.equal(migrated.articles.new.status, 'published');
  assert.equal(migrated.articles.new.liveVerification, 'verified');
  assert.equal(migrated.articles.new.approvedAt, state.articles.new.approvedAt);
  assert.deepEqual(migrated.stages, state.stages);
  assert.equal(migrated.publications[pub.id].status, 'succeeded');
  assert.equal(migrated.publications[pub.id].commit, pub.commit);
  assert.equal(migrated.articles.legacy.status, 'published');
  assert.equal(migrated.articles.legacy.liveVerification, 'unknown');
  assert.deepEqual(await readLifecycle(f.dir), migrated);
  assert.equal(JSON.parse(await fs.readFile(path.join(lifecycleDir(f.dir), 'state.json'))).version, 2);
});

test('migration recovers public availability from the saved production baseline', async () => {
  const f = await fixture();
  await articleLifecycle(f.dir, 'live');
  const post = await getPost('live', f.dir); await writePost({ ...post, body: 'Updated public article' }, f.dir);
  const stage = await stageArticle(f.dir, 'live', await f.provider.context());
  const state = await readLifecycle(f.dir); state.version = 1; state.articles.live.status = 'staged';
  delete state.articles.live.publishing;
  await fs.writeFile(path.join(lifecycleDir(f.dir), 'state.json'), JSON.stringify(state));
  const migrated = await readLifecycle(f.dir);
  assert.equal(migrated.articles.live.status, 'published');
  assert.equal(migrated.articles.live.publishing.status, 'staged');
  assert.equal(migrated.articles.live.stagedRevisionId, stage.id);
  assert.equal(migrated.articles.live.hasPendingChanges, true);
});

test('working dependency errors on published articles preserve availability and remain actionable', async () => {
  const f = await fixture(); const stage = await draft(f); await reviewed(f, stage);
  const pub = await publish(f.dir, { stagedRevisionId: stage.id, message: 'publish' }, f.provider);
  await refreshPublication(f.dir, pub.id, f.provider);
  await fs.rm(path.join(f.dir, 'assets', 'new.png'));
  const record = (await pendingLifecycle(f.dir)).find(item => item.slug === 'new');
  assert.equal(record.status, 'published'); assert.equal(record.publishing.status, 'failed');
  assert.equal(record.hasPendingChanges, true); assert.equal(record.nextAction, 'recover');
  await fs.writeFile(path.join(f.dir, 'assets', 'new.png'), 'asset bytes');
  assert.equal((await articleLifecycle(f.dir, 'new')).publishing.status, 'succeeded');
});

test('migration preserves published edits even after their staged link was invalidated', async () => {
  const f = await fixture(); await articleLifecycle(f.dir, 'live');
  const post = await getPost('live', f.dir);
  await writePost({ ...post, body: 'First edit' }, f.dir);
  await stageArticle(f.dir, 'live', await f.provider.context());
  await writePost({ ...post, body: 'Second edit' }, f.dir);
  await articleLifecycle(f.dir, 'live');
  const state = await readLifecycle(f.dir); state.version = 1; state.articles.live.status = 'draft';
  assert.equal(state.articles.live.stagedRevisionId, undefined);
  delete state.articles.live.publishing;
  await fs.writeFile(path.join(lifecycleDir(f.dir), 'state.json'), JSON.stringify(state));
  const [first, second] = await Promise.all([readLifecycle(f.dir), readLifecycle(f.dir)]);
  assert.deepEqual(first, second); assert.equal(first.articles.live.status, 'published');
  assert.equal(first.articles.live.hasPendingChanges, true);
});

test('single-article reads reconcile verified site-wide revision metadata', async () => {
  const f = await fixture(); const stage = await draft(f); await reviewed(f, stage);
  const pub = await publish(f.dir, { stagedRevisionId: stage.id, message: 'publish' }, f.provider);
  await refreshPublication(f.dir, pub.id, f.provider);
  const { mutateLifecycle, workingRevision } = await import('../packages/content-contract/dist/index.js');
  const liveRevision = (await workingRevision(f.dir, 'live')).revisionId;
  await mutateLifecycle(f.dir, async state => { state.publications[pub.id].liveRevisions = { live: liveRevision, new: stage.revisionId }; });
  const record = await articleLifecycle(f.dir, 'live');
  assert.equal(record.status, 'published'); assert.equal(record.liveVerification, 'verified');
  assert.equal(record.liveRevisionId, liveRevision); assert.equal(record.hasPendingChanges, false);
});

test('frontmatter changes cannot mark an MCP-created article as publicly available', async () => {
  const f = await fixture(); await writePost(article('new', { draft: false }), f.dir);
  const record = await articleLifecycle(f.dir, 'new', true);
  assert.equal(record.status, 'draft'); assert.equal(record.hasPendingChanges, true);
  assert.equal(record.liveVerification, 'unknown');
});
