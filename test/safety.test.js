// SPEC.md "Safety" and "Run": what the site may write, what it refuses, and that it stays local.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { WRITABLE, changedFiles, snapshot, startSite } from './helpers/site.js';

describe('writes', () => {
  let site;
  before(async () => { site = await startSite(); });
  after(async () => { await site?.stop(); });

  test('after using every page, only the three allowed files have changed', async () => {
    const before = snapshot(site.root);
    const { api } = site;

    // Read every page, then make every kind of change the site offers.
    await api.everyDefaultResponse();
    for (const m of await api.meetings()) await api.meetingRaw(m.file, { showPrivate: true });
    await api.importItems(true);
    const [card] = (await api.board()).cards;
    await api.moveCard(card.id, 'done');
    await api.deleteCard(card.id);
    const mine = (await api.addCard({ title: 'Own card' })).json.card;
    await api.editCard(mine.id, { title: 'Own card, edited' });
    await api.addBook({ title: 'Radical Candor', author: 'Kim Scott', read: 'No', used_by: [] });
    await api.addCorrection({ date: '2026-10-01', where: 'w', what: 'x', caught_by: 'Me', decision: 'd', rule: 'r' });

    const changed = changedFiles(before, snapshot(site.root));
    assert.deepEqual(changed.filter((f) => !WRITABLE.includes(f)), [], 'nothing else was written or left behind');
    assert.deepEqual(changed, [...WRITABLE].sort());
  });

  test('paths outside the data root are refused', async () => {
    for (const p of [
      '/api/meeting?file=../CLAUDE.md',
      '/api/meeting?file=..%2F..%2Fetc%2Fpasswd',
      '/api/meeting?file=%2Fetc%2Fpasswd',
      '/api/library/notes?file=../../etc/passwd',
      '/..%2Fpackage.json',
      '/%2e%2e/%2e%2e/etc/passwd',
    ]) {
      const res = await site.get(p);
      assert.ok(res.status >= 400, `${p} -> ${res.status}`);
      assert.doesNotMatch(res.text, /root:|"name": "mission-control-site"/);
    }
  });
});

describe('an unreadable file is never overwritten', () => {
  let site;
  before(async () => { site = await startSite({ prepare: (root) => fs.writeFileSync(path.join(root, 'board', 'board.json'), '{"cards": [ {"id": 1}') }); });
  after(async () => { await site?.stop(); });

  test('the board says "could not read" and refuses to save', async () => {
    const res = await site.api.boardRaw();
    assert.equal(res.ok, false);
    assert.match(res.text, /could not read/);
    const write = await site.post('/api/board/import', { includeSuggested: false });
    assert.equal(write.ok, false);
    assert.equal(site.file('board/board.json'), '{"cards": [ {"id": 1}');
  });
});

describe('local only', () => {
  let site;
  before(async () => { site = await startSite(); });
  after(async () => { await site?.stop(); });

  test('the pages load nothing from the network', async () => {
    const shell = (await site.api.pageShell()).map((r) => r.text).join('\n');
    assert.doesNotMatch(shell, /(src|href)\s*=\s*["']?(https?:)?\/\//i, 'no external scripts, styles or fonts');
    assert.doesNotMatch(shell, /@import\s+url\(\s*["']?https?:/i);
    assert.doesNotMatch(shell, /fetch\(\s*["'`]https?:/i);
  });

  test('it listens on 127.0.0.1 only', async (t) => {
    const external = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal);
    if (!external) return t.skip('no non-loopback address on this machine');
    const reached = await new Promise((resolve) => {
      const sock = net.connect({ host: external.address, port: site.port });
      sock.setTimeout(1500);
      sock.on('connect', () => { sock.destroy(); resolve(true); });
      sock.on('error', () => resolve(false));
      sock.on('timeout', () => { sock.destroy(); resolve(false); });
    });
    assert.equal(reached, false, `not reachable on ${external.address}`);
  });

  test('other websites can\'t read or write through it', async () => {
    // fetch() replaces a custom Host header, so this request goes through node:http.
    const wrongHost = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: site.port, path: '/api/meetings', headers: { Host: `evil.example:${site.port}` } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      }).on('error', reject);
    });
    assert.equal(wrongHost, 403, 'a page on another host name (DNS rebinding) is refused');
    const crossSite = await site.post('/api/board/import', {}, { Origin: 'https://evil.example' });
    assert.equal(crossSite.status, 403);
    const formPost = await fetch(`${site.base}/api/corrections`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
    assert.ok(formPost.status >= 400);
    assert.equal(site.exists('board/board.json'), false, 'nothing was written');
  });
});
