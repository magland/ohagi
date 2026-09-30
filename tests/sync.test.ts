import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { AddressInfo } from 'net';
import { Server } from 'http';
import { EditorState, Transaction } from '@codemirror/state';
import { collab, getClientID, getSyncedVersion, sendableUpdates } from '@codemirror/collab';
import { createApp, findStaticDir } from '../src/server';
import { Shelf } from '../src/shelf';
import { LiveDoc } from '../src/livedoc';
import { Peer, Sync } from '../client/sync';

// Several pages, each running the same sync code the browser runs, typing
// into one file at once, with random pauses; then checks that every page and
// the file on disk hold the same text.

function makeShelf(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ohagi-test-'));
  execFileSync('bash', [path.join(__dirname, '..', 'scripts', 'create-example.sh'), dir], { stdio: 'ignore' });
  return dir;
}

async function serve(root: string, port = 0): Promise<{ server: Server; shelf: Shelf; base: string; stop(): Promise<void> }> {
  const shelf = new Shelf(root);
  const app = createApp(shelf, findStaticDir());
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(port, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    server,
    shelf,
    base,
    stop: async () => {
      shelf.flushAll();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    },
  };
}

class Page {
  state: EditorState;
  sync: Sync;
  resets = 0;
  peers = new Map<string, Peer>();

  constructor(base: string, first: { epoch: string; version: number; doc: string }, readonly name: string) {
    this.state = EditorState.create({ doc: first.doc, extensions: [collab({ startVersion: first.version })] });
    const clientID = getClientID(this.state);
    this.sync = new Sync(
      {
        state: () => this.state,
        dispatch: (tr: Transaction) => {
          this.state = tr.state;
        },
        reset: (doc, version) => {
          this.resets++;
          this.state = EditorState.create({ doc, extensions: [collab({ startVersion: version, clientID })] });
        },
        peer: (p) => this.peers.set(p.clientID, p),
        gone: (id) => this.peers.delete(id),
      },
      { base, collection: 'alice', project: 'paper', path: 'main.tex', epoch: first.epoch, name },
    );
    this.sync.start();
  }

  static async open(base: string, name: string): Promise<Page> {
    const first = await (await fetch(`${base}/api/projects/alice/paper/doc?path=main.tex`)).json();
    return new Page(base, first, name);
  }

  randomEdit(rand: () => number): void {
    const len = this.state.doc.length;
    let changes;
    if (len > 0 && rand() < 0.4) {
      const from = Math.floor(rand() * len);
      changes = { from, to: Math.min(len, from + 1 + Math.floor(rand() * 5)) };
    } else {
      const at = Math.floor(rand() * (len + 1));
      const alphabet = 'abcdefgh \n\\{}';
      let insert = '';
      for (let i = 1 + Math.floor(rand() * 5); i > 0; i--) insert += alphabet[Math.floor(rand() * alphabet.length)];
      changes = { from: at, insert };
    }
    this.state = this.state.update({ changes }).state;
    this.sync.changed();
  }

  select(anchor: number, head: number): void {
    this.state = this.state.update({ selection: { anchor, head } }).state;
    this.sync.select(anchor, head);
  }
}

function seeded(seed: number): () => number {
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function settled(pages: Page[], shelf: Shelf, timeoutMs = 20000): Promise<void> {
  const doc = shelf.doc('alice', 'paper', 'main.tex');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pages.every((p) => sendableUpdates(p.state).length === 0 && getSyncedVersion(p.state) === doc.version)) return;
    await sleep(20);
  }
  throw new Error(
    `pages did not settle: server ${doc.version}, pages ${pages.map((p) => `${getSyncedVersion(p.state)}+${sendableUpdates(p.state).length}`).join(' ')}`,
  );
}

async function typeConcurrently(pages: Page[], edits: number, seed: number): Promise<void> {
  await Promise.all(
    pages.map(async (p, i) => {
      const rand = seeded(seed + i);
      for (let n = 0; n < edits; n++) {
        p.randomEdit(rand);
        const pause = rand();
        if (pause < 0.3) await sleep(Math.floor(pause * 30));
        else if (pause < 0.6) await sleep(0);
      }
    }),
  );
}

test('pages typing at once converge, and a restart continues the same history', async () => {
  const root = makeShelf();
  let srv = await serve(root);
  const port = (srv.server.address() as AddressInfo).port;
  const pages = await Promise.all(['alice', 'bob', 'carol', 'dan'].map((n) => Page.open(srv.base, n)));
  try {
    await typeConcurrently(pages, 200, 1);
    await settled(pages, srv.shelf);
    const text = srv.shelf.doc('alice', 'paper', 'main.tex').text.toString();
    for (const p of pages) assert.equal(p.state.doc.toString(), text);
    srv.shelf.flushAll();
    assert.equal(fs.readFileSync(path.join(root, 'collections/alice/projects/paper/files/main.tex'), 'utf8'), text);
    const versionBefore = srv.shelf.doc('alice', 'paper', 'main.tex').version;
    assert.equal(versionBefore, 800);

    // Restart on the same port while two pages keep typing through it.
    const typing = typeConcurrently(pages.slice(0, 2), 100, 7);
    await srv.stop();
    await sleep(50);
    srv = await serve(root, port);
    await typing;
    await typeConcurrently(pages, 50, 11);
    await settled(pages, srv.shelf);
    const after = srv.shelf.doc('alice', 'paper', 'main.tex');
    for (const p of pages) assert.equal(p.state.doc.toString(), after.text.toString());
    assert.equal(after.version, versionBefore + 400);
    for (const p of pages) assert.equal(p.resets, 0, `${p.name} was reset`);
  } finally {
    for (const p of pages) p.sync.close();
    await srv.stop();
  }
});

test('presence arrives at the other pages, mapped through later changes', async () => {
  const root = makeShelf();
  const srv = await serve(root);
  const [a, b] = await Promise.all([Page.open(srv.base, 'alice'), Page.open(srv.base, 'bob')]);
  try {
    await sleep(200);
    a.select(10, 20);
    await sleep(200);
    const seen = b.peers.get(getClientID(a.state));
    assert.ok(seen, 'bob sees alice');
    assert.equal(seen!.name, 'alice');
    assert.deepEqual([seen!.anchor, seen!.head], [10, 20]);
    // Bob types before alice's selection; the server moves it along.
    b.state = b.state.update({ changes: { from: 0, insert: 'xyz' } }).state;
    b.sync.changed();
    await settled([a, b], srv.shelf);
    a.select(a.state.selection.main.anchor, a.state.selection.main.head);
    await sleep(200);
    const moved = b.peers.get(getClientID(a.state))!;
    assert.deepEqual([moved.anchor, moved.head], [13, 23]);
    a.sync.close();
    await sleep(200);
    assert.equal(b.peers.size, 0, 'alice gone');
  } finally {
    a.sync.close();
    b.sync.close();
    await srv.stop();
  }
});

test('changes logged but never written are replayed on load', () => {
  const root = makeShelf();
  const dir = path.join(root, 'collections/alice/projects/paper');
  const file = path.join(dir, 'files/main.tex');
  const args = [file, path.join(dir, 'collab/main.tex.json'), path.join(dir, 'collab/main.tex.log')] as const;
  const doc = new LiveDoc(...args);
  const original = doc.text.toString();
  let state = EditorState.create({ doc: original });
  const updates = [];
  for (let i = 0; i < 5; i++) {
    const tr = state.update({ changes: { from: i, insert: `${i}` } });
    updates.push({ clientID: 'c1', changes: tr.changes.toJSON() });
    state = tr.state;
  }
  doc.push(doc.epoch, 0, updates);
  // No flush: the process "crashes" here.
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  const again = new LiveDoc(...args);
  assert.equal(again.text.toString(), state.doc.toString());
  assert.equal(again.version, 5);
  assert.equal(again.epoch, doc.epoch);
  assert.equal(fs.readFileSync(file, 'utf8'), state.doc.toString());
});

test('a push against an old version is stale, so a resent push is taken once', () => {
  const root = makeShelf();
  const dir = path.join(root, 'collections/alice/projects/paper');
  const doc = new LiveDoc(path.join(dir, 'files/main.tex'), path.join(dir, 'collab/main.tex.json'), path.join(dir, 'collab/main.tex.log'));
  const state = EditorState.create({ doc: doc.text });
  const u = { clientID: 'c1', changes: state.update({ changes: { from: 0, insert: 'hello ' } }).changes.toJSON() };
  assert.deepEqual(doc.push(doc.epoch, 0, [u]), { accepted: true, version: 1 });
  assert.deepEqual(doc.push(doc.epoch, 0, [u]), { accepted: false, version: 1 });
  assert.ok(doc.text.toString().startsWith('hello \\documentclass'));
});

test('a file edited on disk starts a new history, and open pages are sent the text', async () => {
  const root = makeShelf();
  let srv = await serve(root);
  const port = (srv.server.address() as AddressInfo).port;
  const page = await Page.open(srv.base, 'alice');
  try {
    page.randomEdit(seeded(3));
    await settled([page], srv.shelf);
    await srv.stop();
    fs.writeFileSync(path.join(root, 'collections/alice/projects/paper/files/main.tex'), 'edited elsewhere\n');
    srv = await serve(root, port);
    const deadline = Date.now() + 10000;
    while (page.resets === 0 && Date.now() < deadline) await sleep(20);
    assert.equal(page.resets, 1);
    assert.equal(page.state.doc.toString(), 'edited elsewhere\n');
    page.randomEdit(seeded(4));
    await settled([page], srv.shelf);
    assert.equal(srv.shelf.doc('alice', 'paper', 'main.tex').text.toString(), page.state.doc.toString());
  } finally {
    page.sync.close();
    await srv.stop();
  }
});

test('paths outside the project are refused', async () => {
  const root = makeShelf();
  const srv = await serve(root);
  try {
    for (const p of ['../../../etc/passwd', '/etc/passwd', '.git/config', 'a/../main.tex', 'figures/placeholder.png']) {
      const res = await fetch(`${srv.base}/api/projects/alice/paper/doc?path=${encodeURIComponent(p)}`);
      assert.equal(res.status, 404, p);
    }
    for (const [c, p] of [['..', 'alice'], ['alice', '..'], ['lab', 'paper'], ['api', 'x'], ['.alice', 'paper']]) {
      const res = await fetch(`${srv.base}/api/projects/${encodeURIComponent(c)}/${encodeURIComponent(p)}/doc?path=main.tex`);
      assert.equal(res.status, 404, `${c}/${p}`);
    }
  } finally {
    await srv.stop();
  }
});

test('collections list their projects, and projects their files', async () => {
  const root = makeShelf();
  const srv = await serve(root);
  try {
    const home = await (await fetch(`${srv.base}/`)).text();
    assert.match(home, /href="\/alice"/);
    assert.match(home, /href="\/lab"/);
    const lab = await (await fetch(`${srv.base}/lab`)).text();
    assert.match(lab, /href="\/lab\/proposal"/);
    assert.doesNotMatch(lab, /paper/);
    const paper = await (await fetch(`${srv.base}/alice/paper`)).text();
    assert.match(paper, /href="\/alice\/paper\/f\/main.tex"/);
    assert.match(paper, /href="\/alice\/paper\/f\/refs.bib"/);
    assert.doesNotMatch(paper, /href="[^"]*placeholder.png"/);
    assert.equal((await fetch(`${srv.base}/alice/paper/f/main.tex`)).status, 200);
    assert.equal((await fetch(`${srv.base}/nobody`)).status, 404);
    assert.equal((await fetch(`${srv.base}/lab/paper`)).status, 404);
    assert.equal((await fetch(`${srv.base}/assets/editor.js`)).status, 200);
  } finally {
    await srv.stop();
  }
});
