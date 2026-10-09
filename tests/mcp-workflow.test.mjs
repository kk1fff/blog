import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { gitCommand, lifecycleDir } from '../packages/content-contract/dist/index.js';
const exec = promisify(execFile);
const repository = path.resolve('.');
function parse(result) {
  const body = result.content.find(item => item.type === 'text').text;
  if (result.isError) throw new Error(body);
  return JSON.parse(body);
}
async function connect(name, root, content, extraEnv = {}) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(repository, `packages/${name}/dist/index.js`)], env: { ...process.env, AGENTIC_BLOG_ROOT: root, BLOG_CONTENT_DIR: content, ...extraEnv }, stderr: 'pipe' });
  const client = new Client({ name: 'workflow-test', version: '1' }); await client.connect(transport);
  return { client, transport, call: (name, args = {}) => client.callTool({ name, arguments: args }, undefined, { timeout: 180000 }) };
}

test('MCP article lifecycle and pinned browser preview survive reopen and close listeners on stdin EOF', { timeout: 180000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-mcp-'));
  const originalRoot = process.env.AGENTIC_BLOG_ROOT;
  process.env.AGENTIC_BLOG_ROOT = root;
  const content = path.join(root, 'content'); const engine = path.join(root, 'engine');
  let contentMcp; let previewMcp;
  try {
    await fs.mkdir(content); await fs.mkdir(engine);
    // The workspace preview builds current site code; staged previews build the fixture's pinned engine.
    for (const name of ['apps', 'packages', 'package.json', 'node_modules']) await fs.symlink(path.join(repository, name), path.join(root, name));
    for (const name of ['apps', 'packages', 'package.json', 'package-lock.json', 'tsconfig.json', '.gitignore']) {
      await fs.cp(path.join(repository, name), path.join(engine, name), { recursive: true, filter: source => !source.split(path.sep).some(part => ['node_modules', 'dist', '.astro', '.agentic-blog', 'static_content'].includes(part)) });
    }
    for (const dir of [content, engine]) {
      await gitCommand(dir, ['init', '-b', 'main']); await gitCommand(dir, ['config', 'user.email', 'test@example.com']); await gitCommand(dir, ['config', 'user.name', 'Test']);
    }
    await fs.mkdir(path.join(content, 'assets'));
    await fs.writeFile(path.join(content, 'assets', 'engineers-note-mark.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><rect width="20" height="20" fill="blue"/></svg>');
    await fs.writeFile(path.join(content, 'blog.yaml'), 'hosting: github-pages\ngithubPages:\n  productionBranch: main\nsite:\n  title: Lifecycle Preview\n  description: Integration fixture\npublishing:\n  mode: push\n  productionBranch: main\n');
    await gitCommand(content, ['add', '-A']); await gitCommand(content, ['commit', '-m', 'baseline']);
    await gitCommand(engine, ['add', '-A']); await gitCommand(engine, ['commit', '-m', 'fixture engine']);
    const engineCommit = await gitCommand(engine, ['rev-parse', 'HEAD']);
    const bin = path.join(root, 'bin'); await fs.mkdir(bin);
    await fs.writeFile(path.join(bin, 'gh'), `#!/usr/bin/env node
const endpoint = process.argv[3];
if (endpoint.endsWith('/BLOG_ENGINE_COMMIT')) process.stdout.write(JSON.stringify({value: process.env.TEST_ENGINE_COMMIT}));
else if (endpoint.endsWith('/BLOG_ENGINE_REPOSITORY')) process.stdout.write(JSON.stringify({value: process.env.TEST_ENGINE_REPOSITORY}));
else if (endpoint.endsWith('/CLOUDFLARE_WEB_ANALYTICS_TOKEN')) process.stdout.write(JSON.stringify({value: ''}));
else { process.stderr.write('Unexpected test GitHub endpoint'); process.exit(1); }
`, { mode: 0o755 });
    await gitCommand(content, ['remote', 'add', 'origin', 'https://github.com/fixture/content.git']);
    const extraEnv = { PATH: `${bin}:${process.env.PATH}`, TEST_ENGINE_COMMIT: engineCommit, TEST_ENGINE_REPOSITORY: engine,
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.${content}/.insteadOf`, GIT_CONFIG_VALUE_0: 'https://github.com/fixture/content.git' };
    contentMcp = await connect('content-mcp', root, content, extraEnv);
    const toolNames = (await contentMcp.client.listTools()).tools.map(tool => tool.name);
    assert.ok(toolNames.includes('stage_article')); assert.ok(toolNames.includes('approve_article')); assert.ok(!toolNames.includes('publish_article'));
    const post = parse(await contentMcp.call('create_post', { title: 'A staged article', slug: 'sample', body: '## A real preview\n\nThis article remains a draft while its pinned snapshot is reviewed.' }));
    assert.equal(post.draft, true); assert.equal(post.lifecycle.status, 'draft');
    assert.equal(parse(await contentMcp.call('list_posts', { pendingOnly: true })).length, 1);
    const privatePost = parse(await contentMcp.call('create_post', { title: 'Local draft', slug: 'private', tags: ['preview'], body: 'Only visible in the local workspace.' }));
    assert.equal(privatePost.status, 'draft'); assert.equal(privatePost.hasPendingChanges, true);
    assert.equal(parse(await contentMcp.call('list_posts', { status: 'draft' })).length, 2);
    assert.equal(parse(await contentMcp.call('list_posts', { status: 'published' })).length, 0);
    assert.equal((await contentMcp.call('list_posts', { status: 'staged' })).isError, true);
    const stage = parse(await contentMcp.call('stage_article', { slug: 'sample' }));
    assert.equal(parse(await contentMcp.call('list_posts', { publishingStatus: 'staged' })).length, 1);
    const summary = parse(await contentMcp.call('blog_status'));
    assert.deepEqual(summary.articleCounts, { draft: 2, published: 0 });
    assert.equal(summary.publishingCounts.staged, 1);
    previewMcp = await connect('preview-mcp', root, content);
    const workspace = parse(await previewMcp.call('open_preview'));
    assert.equal(workspace.mode, 'workspace'); assert.equal(workspace.stagedRevisionId, undefined);
    const workspaceUrl = workspace.urls.find(url => url.startsWith('http://127.0.0.1:'));
    const workspaceEntry = await fetch(workspaceUrl, { redirect: 'manual' });
    const workspaceCookie = workspaceEntry.headers.get('set-cookie').split(';')[0];
    async function workspacePage(route) {
      const response = await fetch(new URL(route, workspaceUrl), { headers: { cookie: workspaceCookie } });
      assert.equal(response.status, 200); return response.text();
    }
    assert.match(await workspacePage('/'), /Local draft/);
    assert.match(await workspacePage('/posts/private/'), /Only visible in the local workspace/);
    assert.match(await workspacePage('/search-index.json'), /private/);
    assert.match(await workspacePage('/tags/'), /preview/);
    assert.match(await workspacePage('/tags/preview/'), /Local draft/);
    for (const viewport of ['desktop', 'phone']) {
      const metadata = parse(await previewMcp.call('render_page', { previewId: workspace.previewId, route: '/posts/private/', viewport }));
      assert.equal(metadata.port, workspace.port);
      const artifacts = path.join(repository, '.agentic-blog', 'validation'); await fs.mkdir(artifacts, { recursive: true });
      await fs.copyFile(metadata.screenshot, path.join(artifacts, `workspace-${viewport}.png`));
    }
    // Workspace screenshots must never count toward a staged article's approval.
    assert.equal((await contentMcp.call('approve_article', { stagedRevisionId: stage.id })).isError, true);
    assert.equal(parse(await previewMcp.call('preview_status', { previewId: workspace.previewId })).previews.length, 1);
    await previewMcp.call('close_preview', { previewId: workspace.previewId });
    await assert.rejects(fetch(workspaceUrl));
    assert.equal((await previewMcp.call('close_preview')).isError, true);
    const opened = parse(await previewMcp.call('open_preview', { stagedRevisionId: stage.id }));
    assert.equal(opened.revisionId, stage.revisionId); assert.ok(opened.urls.length); assert.equal(opened.status, 'running');
    const url = opened.urls.find(url => url.startsWith('http://127.0.0.1:'));
    const entry = await fetch(url, { redirect: 'manual' }); const cookie = entry.headers.get('set-cookie').split(';')[0];
    const articleUrl = new URL('/posts/sample/', url).href;
    const article = await fetch(articleUrl, { headers: { cookie } }); assert.equal(article.status, 200);
    assert.match(await article.text(), new RegExp(stage.revisionId));
    const build = path.join(lifecycleDir(content), 'stages', stage.id, 'build');
    const productionMarker = JSON.parse(await fs.readFile(path.join(build, 'publication-manifest.json'), 'utf8'));
    await assert.rejects(fs.access(path.join(build, 'posts', 'private', 'index.html')));
    assert.doesNotMatch(await fs.readFile(path.join(build, 'index.html'), 'utf8'), /Local draft/);
    assert.doesNotMatch(await fs.readFile(path.join(build, 'search-index.json'), 'utf8'), /private/);
    assert.equal(productionMarker.engine.commit, engineCommit); assert.equal(productionMarker.articleRevisions.sample, stage.revisionId);
    for (const viewport of ['desktop', 'phone']) {
      const rendered = await previewMcp.call('render_page', { stagedRevisionId: stage.id, viewport });
      assert.ok(rendered.content.some(item => item.type === 'image'));
      const metadata = parse(rendered); assert.equal(metadata.port, opened.port);
      const artifacts = path.join(repository, '.agentic-blog', 'validation'); await fs.mkdir(artifacts, { recursive: true });
      await fs.copyFile(metadata.screenshot, path.join(artifacts, `staged-${viewport}.png`));
    }
    const approved = parse(await contentMcp.call('approve_article', { stagedRevisionId: stage.id })); assert.equal(approved.status, 'draft'); assert.equal(approved.publishing.status, 'ready_to_publish');
    await fs.writeFile(path.join(build, 'posts', 'sample', 'index.html'), 'corrupted output');
    await previewMcp.call('open_preview', { stagedRevisionId: stage.id });
    assert.equal(parse(await contentMcp.call('get_post', { slug: 'sample' })).lifecycle.publishing.status, 'staged');
    assert.equal((await contentMcp.call('approve_article', { stagedRevisionId: stage.id })).isError, true);
    assert.match(await fs.readFile(path.join(build, 'posts', 'sample', 'index.html'), 'utf8'), /A staged article/);
    const updated = parse(await contentMcp.call('update_post', { slug: 'sample', body: 'Changed after approval' })); assert.equal(updated.lifecycle.status, 'draft');
    const stale = await contentMcp.call('approve_article', { stagedRevisionId: stage.id }); assert.equal(stale.isError, true);
    assert.equal(parse(await previewMcp.call('open_preview', { stagedRevisionId: stage.id })).port, opened.port);
    await previewMcp.call('close_preview', { stagedRevisionId: stage.id });
    const reopened = parse(await previewMcp.call('open_preview', { stagedRevisionId: stage.id })); assert.notEqual(reopened.urls[0], opened.urls[0]);
    // End the transport without an explicit stop: the MCP must own listener cleanup.
    const child = previewMcp.transport._process;
    const exited = new Promise((resolve, reject) => { child.once('exit', resolve); setTimeout(() => reject(new Error('MCP stayed alive after stdin EOF')), 10000).unref(); });
    child.stdin.end(); await exited;
    await assert.rejects(fetch(reopened.urls.find(url => url.startsWith('http://127.0.0.1:')), { signal: AbortSignal.timeout(2000) }));
    await previewMcp.client.close(); previewMcp = await connect('preview-mcp', root, content);
    assert.equal(parse(await previewMcp.call('preview_status')).previews.length, 0);
    assert.equal(parse(await previewMcp.call('open_preview', { stagedRevisionId: stage.id })).revisionId, stage.revisionId);
    await previewMcp.call('stop_preview_server');
  } finally {
    await previewMcp?.client.close(); await contentMcp?.client.close();
    if (originalRoot === undefined) delete process.env.AGENTIC_BLOG_ROOT; else process.env.AGENTIC_BLOG_ROOT = originalRoot;
    await fs.rm(root, { recursive: true, force: true });
  }
});
