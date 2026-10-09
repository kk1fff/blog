import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import test, { after } from 'node:test';
import { PreviewServers, networkAddresses } from '../packages/preview-mcp/dist/preview.js';
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-preview-'));
after(() => fs.rm(root, { recursive: true, force: true }));
await fs.mkdir(path.join(root, 'posts', 'sample'), { recursive: true });
await fs.mkdir(path.join(root, 'assets'));
await fs.writeFile(path.join(root, 'posts', 'sample', 'index.html'), '<html><img src="/assets/test.svg"></html>');
await fs.writeFile(path.join(root, 'assets', 'test.svg'), '<svg></svg>');
await fs.writeFile(path.join(root, 'index.html'), 'home');
async function authenticated(preview) {
  const origin = `http://127.0.0.1:${preview.port}`;
  const response = await fetch(`${origin}/posts/sample/?previewToken=${preview.token}`, { redirect: 'manual' });
  return { origin, cookie: response.headers.get('set-cookie').split(';')[0], response };
}

test('preview stays open after returning, reuses a listener, protects pages/assets, and revokes access on close', async () => {
  const servers = new PreviewServers();
  try {
    const preview = await servers.open('sample', root, '/posts/sample/');
    assert.equal((await servers.open('sample', root, '/posts/sample/')).port, preview.port);
    assert.equal((await fetch(`http://127.0.0.1:${preview.port}/assets/test.svg`)).status, 403);
    const { origin, cookie, response } = await authenticated(preview);
    assert.equal(response.status, 303); assert.equal(response.headers.get('location'), '/posts/sample/');
    assert.equal((await fetch(`${origin}/posts/sample/`, { headers: { cookie } })).status, 200);
    assert.equal((await fetch(`${origin}/assets/test.svg`, { headers: { cookie } })).status, 200);
    assert.equal((await fetch(`${origin}/missing`, { headers: { cookie } })).status, 404);
    assert.equal((await fetch(`${origin}/%2e%2e%2fsecret`, { headers: { cookie } })).status, 404);
    await servers.close('sample'); assert.deepEqual(servers.status(), []);
    await assert.rejects(fetch(`${origin}/`, { headers: { cookie } }));
    const reopened = await servers.open('sample', root, '/posts/sample/');
    assert.notEqual(reopened.token, cookie.split('=')[1]);
  } finally { await servers.stop(); }
});

test('concurrent opens return one listener, stop cancels opens and preserves build files', async () => {
  const servers = new PreviewServers();
  try {
    const [a, b] = await Promise.all([servers.open('same', root, '/'), servers.open('same', root, '/')]);
    assert.equal(a.port, b.port);
    await servers.stop(); assert.equal(servers.status().length, 0);
    assert.equal(await fs.readFile(path.join(root, 'index.html'), 'utf8'), 'home');
    const opening = servers.open('cancelled', root, '/'); const stopped = servers.stop();
    await assert.rejects(opening, /cancelled/); await stopped; assert.equal(servers.status().length, 0);
  } finally { await servers.stop(); }
});

test('interface enumeration prioritizes Tailscale and labels IPv6, loopback, and link-local addresses', () => {
  const addresses = networkAddresses({
    eth0: [{ address: '192.168.1.2', family: 'IPv4', internal: false }],
    lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    tailscale0: [{ address: '100.70.97.72', family: 'IPv4', internal: false }, { address: 'fd7a:115c:a1e0::1', family: 'IPv6', internal: false }, { address: 'fe80::1', family: 'IPv6', internal: false }]
  });
  assert.equal(addresses[0].address, '100.70.97.72');
  assert.equal(addresses.find(a => a.address === 'fe80::1').linkLocal, true);
  assert.equal(addresses.find(a => a.address === '127.0.0.1').internal, true);
});

test('network URLs include actual ports and bracketed IPv6 addresses', async () => {
  const servers = new PreviewServers();
  try {
    const preview = await servers.open('urls', root, '/posts/sample/');
    const info = servers.info(preview);
    assert.ok(info.urls.some(url => url.startsWith(`http://127.0.0.1:${preview.port}/posts/sample/?previewToken=`)));
    if (preview.ipv6) assert.ok(info.urls.some(url => url.startsWith(`http://[::1]:${preview.port}/`)));
    assert.ok(info.addresses.every(a => !a.linkLocal || !a.url));
  } finally { await servers.stop(); }
});

test('disposed MCP preview manager cannot start a listener after connection shutdown', async () => {
  const servers = new PreviewServers(); const epoch = servers.epoch();
  await servers.dispose(); assert.notEqual(servers.epoch(), epoch);
  await assert.rejects(servers.open('late', root, '/'), /connection is closed/);
});

test('MCP shutdown cancels an owned build process instead of leaving it running', async () => {
  const { runPreviewCommand, cancelPreviewBuilds } = await import('../packages/preview-mcp/dist/preview.js');
  const marker = path.join(root, 'build-pid');
  const running = runPreviewCommand(process.execPath, ['-e', 'require("node:fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)', marker], root, process.env);
  // Attach a rejection handler before signalling cancellation.
  const cancelled = assert.rejects(running, /closed during build/);
  for (let attempt = 0; attempt < 100 && !(await fs.stat(marker).catch(() => undefined)); attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  const pid = Number(await fs.readFile(marker, 'utf8'));
  cancelPreviewBuilds(); await cancelled;
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
});
