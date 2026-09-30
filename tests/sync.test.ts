import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AddressInfo } from 'net';
import { Server } from 'http';
import { EditorState, Transaction } from '@codemirror/state';
import { collab, getClientID, getSyncedVersion, sendableUpdates } from '@codemirror/collab';
import { createApp } from '../src/server';
import { Docs } from '../src/docs';
import { Compiler } from '../src/compile';
import { LiveDoc } from '../src/livedoc';
import { ProjectRef, findProject } from '../src/projects';
import { Peer, Sync } from '../client/sync';
import { EXAMPLE_TOKENS, createExample } from '../scripts/create-example';

// Several pages, each running the same sync code the browser runs, typing
// into one file at once, with random pauses; then checks that every page and
// the file on disk hold the same text.

type User = keyof typeof EXAMPLE_TOKENS;

function makeShelf(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ohagi-test-'));
  createExample(dir);
  return dir;
}

const PAPER = 'collections/alice/projects/paper';

function paperRef(root: string): ProjectRef {
  return findProject(root, 'alice', 'paper')!;
}

/** The server's live copy of alice/paper's main.tex. */
function liveDoc(srv: { docs: Docs; root: string }): LiveDoc {
  return srv.docs.get(paperRef(srv.root), 'main.tex');
}

async function serve(root: string, port = 0): Promise<{ server: Server; docs: Docs; root: string; base: string; stop(): Promise<void> }> {
  const docs = new Docs();
  const app = createApp(root, docs, new Compiler());
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(port, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    server,
    docs,
    root,
    base,
    stop: async () => {
      docs.flushAll();
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
  closedWith: { reason: string; to?: string } | null = null;

  constructor(base: string, first: { epoch: string; version: number; doc: string }, readonly name: User, file = 'main.tex') {
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
        closed: (reason, to) => {
          this.closedWith = { reason, to };
        },
      },
      {
        base,
        collection: 'alice',
        project: 'paper',
        path: file,
        epoch: first.epoch,
        headers: { Authorization: `Bearer ${EXAMPLE_TOKENS[name]}` },
      },
    );
    this.sync.start();
  }

  static async open(base: string, name: User, file = 'main.tex'): Promise<Page> {
    const first = await (await fetch(`${base}/api/projects/alice/paper/doc?path=${encodeURIComponent(file)}`, { headers: auth(name) })).json();
    return new Page(base, first, name, file);
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

function auth(user: User): Record<string, string> {
  return { Authorization: `Bearer ${EXAMPLE_TOKENS[user]}` };
}

function seeded(seed: number): () => number {
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function settled(pages: Page[], srv: { docs: Docs; root: string }, timeoutMs = 20000): Promise<void> {
  const doc = liveDoc(srv);
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
  const pages = await Promise.all((['alice', 'bob', 'dev'] as User[]).map((n) => Page.open(srv.base, n)));
  try {
    await typeConcurrently(pages, 200, 1);
    await settled(pages, srv);
    const text = liveDoc(srv).text.toString();
    for (const p of pages) assert.equal(p.state.doc.toString(), text);
    srv.docs.flushAll();
    assert.equal(fs.readFileSync(path.join(root, PAPER, 'files/main.tex'), 'utf8'), text);
    const versionBefore = liveDoc(srv).version;
    assert.equal(versionBefore, 600);

    // Restart on the same port while two pages keep typing through it.
    const typing = typeConcurrently(pages.slice(0, 2), 100, 7);
    await srv.stop();
    await sleep(50);
    srv = await serve(root, port);
    await typing;
    await typeConcurrently(pages, 50, 11);
    await settled(pages, srv);
    const after = liveDoc(srv);
    for (const p of pages) assert.equal(p.state.doc.toString(), after.text.toString());
    assert.equal(after.version, versionBefore + 350);
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
    await settled([a, b], srv);
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
  const dir = path.join(root, PAPER);
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
  const dir = path.join(root, PAPER);
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
    await settled([page], srv);
    await srv.stop();
    fs.writeFileSync(path.join(root, PAPER, 'files/main.tex'), 'edited elsewhere\n');
    srv = await serve(root, port);
    const deadline = Date.now() + 10000;
    while (page.resets === 0 && Date.now() < deadline) await sleep(20);
    assert.equal(page.resets, 1);
    assert.equal(page.state.doc.toString(), 'edited elsewhere\n');
    page.randomEdit(seeded(4));
    await settled([page], srv);
    assert.equal(liveDoc(srv).text.toString(), page.state.doc.toString());
  } finally {
    page.sync.close();
    await srv.stop();
  }
});

test('paths outside the project are refused', async () => {
  const root = makeShelf();
  const srv = await serve(root);
  try {
    for (const p of ['../../../etc/passwd', '/etc/passwd', '.git/config', 'a/../main.tex', 'figures/placeholder.png', '../access.json']) {
      const res = await fetch(`${srv.base}/api/projects/alice/paper/doc?path=${encodeURIComponent(p)}`, { headers: auth('alice') });
      assert.equal(res.status, 404, p);
    }
    for (const [c, p] of [['..', 'alice'], ['alice', '..'], ['lab', 'paper'], ['api', 'x'], ['.alice', 'paper']]) {
      const res = await fetch(`${srv.base}/api/projects/${encodeURIComponent(c)}/${encodeURIComponent(p)}/doc?path=main.tex`, {
        headers: auth('dev'),
      });
      assert.equal(res.status, 404, `${c}/${p}`);
    }
  } finally {
    await srv.stop();
  }
});

/** Sign in through mochi's /login form, as a browser does; returns the session cookie. */
async function signIn(base: string, user: User): Promise<string> {
  const res = await fetch(`${base}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: user, token: EXAMPLE_TOKENS[user], next: '/' }).toString(),
  });
  assert.equal(res.status, 302, `sign in as ${user}`);
  const cookie = res.headers.get('set-cookie') ?? '';
  assert.match(cookie, /^ohagi_session=/);
  return cookie.split(';')[0];
}

async function getPage(base: string, url: string, cookie?: string): Promise<{ status: number; body: string; location: string | null }> {
  const res = await fetch(`${base}${url}`, { redirect: 'manual', headers: cookie ? { Cookie: cookie } : {} });
  return { status: res.status, body: await res.text(), location: res.headers.get('location') };
}

test('who sees what: members only, by mochi roles', async () => {
  const root = makeShelf();
  const srv = await serve(root);
  try {
    // Nobody signed in sees no project, and a project address sends them to sign in.
    const anon = await getPage(srv.base, '/');
    assert.match(anon.body, /Sign in<\/a> to see yours/);
    assert.doesNotMatch(anon.body, /alice\/paper/);
    const anonProject = await getPage(srv.base, '/alice/paper');
    assert.equal(anonProject.status, 302);
    assert.match(anonProject.location ?? '', /^\/login\?next=/);
    assert.equal((await fetch(`${srv.base}/api/projects/alice/paper/doc?path=main.tex`)).status, 401);

    // alice owns alice/paper and is not on lab/proposal.
    const alice = await signIn(srv.base, 'alice');
    const home = await getPage(srv.base, '/', alice);
    assert.match(home.body, /href="\/alice\/paper"/);
    assert.doesNotMatch(home.body, /href="\/lab\/proposal"/);
    assert.equal((await getPage(srv.base, '/lab/proposal', alice)).status, 404);
    const paper = await getPage(srv.base, '/alice/paper', alice);
    assert.match(paper.body, /href="\/alice\/paper\/edit\/main.tex"/);
    assert.match(paper.body, /href="\/alice\/paper\/edit\/refs.bib"/);
    assert.match(paper.body, /href="\/alice\/paper\/raw\/figures\/placeholder.png"/);
    assert.doesNotMatch(paper.body, /href="\/alice\/paper\/edit\/figures\/placeholder.png"/);
    assert.match(paper.body, /Private/);
    // The page is mochi's layout with ohagi's logo and stylesheet.
    assert.match(paper.body, /class="topbar"/);
    assert.match(paper.body, /aria-label="ohagi"/);
    assert.match(paper.body, /\/assets\/ohagi\.css\?v=/);
    assert.equal((await getPage(srv.base, '/alice/paper/edit/figures/placeholder.png', alice)).status, 404);

    // bob writes alice/paper and administers lab/proposal, so he sees both.
    const bob = await signIn(srv.base, 'bob');
    const bobHome = await getPage(srv.base, '/', bob);
    assert.match(bobHome.body, /href="\/alice\/paper"/);
    assert.match(bobHome.body, /href="\/lab\/proposal"/);

    // carol reads alice/paper: the editor opens read-only, and a push is refused.
    const carol = await signIn(srv.base, 'carol');
    const carolEditor = await getPage(srv.base, '/alice/paper/edit/main.tex', carol);
    assert.equal(carolEditor.status, 200);
    assert.match(carolEditor.body, /Read only/);
    assert.match(carolEditor.body, /data-writable=""/);
    const first = await (await fetch(`${srv.base}/api/projects/alice/paper/doc?path=main.tex`, { headers: auth('carol') })).json();
    const change = EditorState.create({ doc: first.doc }).update({ changes: { from: 0, insert: 'x' } }).changes.toJSON();
    const refused = await fetch(`${srv.base}/api/projects/alice/paper/push?path=main.tex`, {
      method: 'POST',
      headers: { ...auth('carol'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ epoch: first.epoch, version: first.version, updates: [{ clientID: 'c', changes: change }] }),
    });
    assert.equal(refused.status, 403);

    // A signed-in browser's push needs the session's CSRF value, which the editor page carries.
    const bobEditor = await getPage(srv.base, '/alice/paper/edit/main.tex', bob);
    const csrf = /data-csrf="([^"]+)"/.exec(bobEditor.body)![1];
    const push = (body: Record<string, unknown>) =>
      fetch(`${srv.base}/api/projects/alice/paper/push?path=main.tex`, {
        method: 'POST',
        headers: { Cookie: bob, 'Content-Type': 'application/json' },
        body: JSON.stringify({ epoch: first.epoch, version: first.version, updates: [{ clientID: 'b', changes: change }], ...body }),
      });
    assert.equal((await push({})).status, 403, 'no CSRF value');
    assert.equal((await push({ csrf: 'wrong' })).status, 403, 'wrong CSRF value');
    const ok = await push({ csrf });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { accepted: true, version: first.version + 1 });

    // The jump box lists what the viewer can open, and nothing else.
    const jump = await (await fetch(`${srv.base}/assets/repos.json`, { headers: { Cookie: alice } })).json();
    assert.deepEqual(jump, [{ name: 'alice/paper' }]);
  } finally {
    await srv.stop();
  }
});

test('creating a project and a collection follows mochi’s rules', async () => {
  const root = makeShelf();
  const srv = await serve(root);
  try {
    const carol = await signIn(srv.base, 'carol');
    const form = await getPage(srv.base, '/new', carol);
    const csrf = /name="csrf" value="([^"]+)"/.exec(form.body)![1];
    const create = (collection: string, name: string) =>
      fetch(`${srv.base}/new`, {
        method: 'POST',
        redirect: 'manual',
        headers: { Cookie: carol, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ csrf, collection, name, description: 'Notes' }).toString(),
      });
    // Her own collection is hers to create on the way.
    const made = await create('carol', 'notes');
    assert.equal(made.status, 303);
    assert.equal(made.headers.get('location'), '/carol/notes');
    assert.equal((await getPage(srv.base, '/carol/notes', carol)).status, 200);
    assert.ok(fs.existsSync(path.join(root, 'collections/carol/projects/notes/files/main.tex')));
    // Not someone else's, and not a new one under another name.
    assert.equal((await create('alice', 'intrusion')).status, 403);
    assert.equal((await create('elsewhere', 'x')).status, 403);
    assert.equal((await create('carol', 'notes')).status, 409);
    assert.equal((await create('carol', 'api')).status, 400);
    // It is private: alice cannot see it.
    const alice = await signIn(srv.base, 'alice');
    assert.equal((await getPage(srv.base, '/carol/notes', alice)).status, 404);
  } finally {
    await srv.stop();
  }
});

test('project settings: collaborators, visibility, and deletion, by role', async () => {
  const root = makeShelf();
  const srv = await serve(root);
  try {
    const alice = await signIn(srv.base, 'alice');
    const bob = await signIn(srv.base, 'bob');
    const carol = await signIn(srv.base, 'carol');
    const csrfOf = async (cookie: string, url: string) => /name="csrf" value="([^"]+)"/.exec((await getPage(srv.base, url, cookie)).body)![1];
    const post = async (cookie: string, url: string, fields: Record<string, string>) =>
      fetch(`${srv.base}${url}`, {
        method: 'POST',
        redirect: 'manual',
        headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(fields).toString(),
      });

    // carol reads, so she has no settings page; bob writes, so he may change the
    // description and nothing else.
    assert.equal((await getPage(srv.base, '/alice/paper/settings', carol)).status, 403);
    const bobCsrf = await csrfOf(bob, '/alice/paper/settings');
    assert.equal((await post(bob, '/alice/paper/settings', { csrf: bobCsrf, description: 'Edited by bob' })).status, 303);
    assert.match((await getPage(srv.base, '/alice/paper', alice)).body, /Edited by bob/);
    assert.equal((await post(bob, '/alice/paper/settings/collaborators', { csrf: bobCsrf, username: 'bob', role: 'admin' })).status, 403);

    // alice owns it: she adds and removes collaborators, but only real users.
    const aliceCsrf = await csrfOf(alice, '/alice/paper/settings');
    assert.equal((await post(alice, '/alice/paper/settings/collaborators', { csrf: aliceCsrf, username: 'nobody', role: 'read' })).status, 404);
    assert.equal((await post(alice, '/alice/paper/settings/collaborators/remove', { csrf: aliceCsrf, username: 'carol' })).status, 303);
    assert.equal((await getPage(srv.base, '/alice/paper', carol)).status, 404, 'carol is off the project');

    // Made public, anyone signed in can read it, and write takes a role still.
    assert.equal((await post(alice, '/alice/paper/settings/visibility', { csrf: aliceCsrf, private: 'false' })).status, 303);
    const carolView = await getPage(srv.base, '/alice/paper/edit/main.tex', carol);
    assert.equal(carolView.status, 200);
    assert.match(carolView.body, /Read only/);

    // Deleting takes the name typed out.
    assert.equal((await post(alice, '/alice/paper/settings/delete', { csrf: aliceCsrf, confirm: 'paper' })).status, 400);
    const deleted = await post(alice, '/alice/paper/settings/delete', { csrf: aliceCsrf, confirm: 'alice/paper' });
    assert.equal(deleted.status, 303);
    assert.ok(!fs.existsSync(path.join(root, PAPER)));
    assert.equal((await getPage(srv.base, '/alice/paper', alice)).status, 404);
  } finally {
    await srv.stop();
  }
});

test('collection settings: owners, and deleting only when empty', async () => {
  const root = makeShelf();
  const srv = await serve(root);
  try {
    const dev = await signIn(srv.base, 'dev');
    const alice = await signIn(srv.base, 'alice');
    const post = async (cookie: string, url: string, fields: Record<string, string>) =>
      fetch(`${srv.base}${url}`, {
        method: 'POST',
        redirect: 'manual',
        headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(fields).toString(),
      });
    // alice does not own lab.
    assert.equal((await getPage(srv.base, '/lab/settings', alice)).status, 403);
    const page = await getPage(srv.base, '/lab/settings', dev);
    assert.equal(page.status, 200);
    const csrf = /name="csrf" value="([^"]+)"/.exec(page.body)![1];
    assert.equal((await post(dev, '/lab/settings/owners', { csrf, username: 'alice' })).status, 303);
    // Now she owns it, and with it every project in it.
    assert.equal((await getPage(srv.base, '/lab/proposal', alice)).status, 200);
    assert.equal((await getPage(srv.base, '/lab/settings', alice)).status, 200);
    // A collection with projects is not deleted.
    assert.equal((await post(dev, '/lab/settings/delete', { csrf, confirm: 'lab' })).status, 409);
    assert.equal((await post(dev, '/lab/settings/owners/remove', { csrf, username: 'alice' })).status, 303);
    assert.equal((await getPage(srv.base, '/lab/proposal', alice)).status, 404);
  } finally {
    await srv.stop();
  }
});

test('files: create, upload over an open file, rename and delete under an open editor', async () => {
  const root = makeShelf();
  const srv = await serve(root);
  const open: Page[] = [];
  try {
    const bob = await signIn(srv.base, 'bob');
    const csrf = /name="csrf" value="([^"]+)"/.exec((await getPage(srv.base, '/alice/paper/new', bob)).body)![1];
    const post = (url: string, fields: Record<string, string>) =>
      fetch(`${srv.base}${url}`, {
        method: 'POST',
        redirect: 'manual',
        headers: { Cookie: bob, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(fields).toString(),
      });
    const files = path.join(root, PAPER, 'files');

    // A new file, in a new directory, opens in the editor.
    const made = await post('/alice/paper/new', { csrf, path: 'chapters/intro.tex' });
    assert.equal(made.status, 303);
    assert.equal(made.headers.get('location'), '/alice/paper/edit/chapters/intro.tex');
    assert.equal(fs.readFileSync(path.join(files, 'chapters/intro.tex'), 'utf8'), '');
    assert.equal((await post('/alice/paper/new', { csrf, path: 'chapters/intro.tex' })).status, 409);
    for (const bad of ['../escape.tex', '.hidden', 'main.tex/inside', '']) {
      assert.ok([400, 409].includes((await post('/alice/paper/new', { csrf, path: bad })).status), bad);
    }

    // An upload over a file someone has open: their page takes the new text.
    const page = await Page.open(srv.base, 'alice');
    open.push(page);
    await sleep(200);
    const form = new FormData();
    form.set('csrf', csrf);
    form.set('dir', '');
    form.append('files', new Blob(['\\documentclass{article}\\begin{document}Uploaded.\\end{document}\n']), 'main.tex');
    form.append('files', new Blob([Buffer.from('89504e470d0a1a0a', 'hex')]), 'logo.png');
    const up = await fetch(`${srv.base}/alice/paper/upload`, { method: 'POST', redirect: 'manual', headers: { Cookie: bob }, body: form });
    assert.equal(up.status, 303);
    const deadline = Date.now() + 5000;
    while (!page.state.doc.toString().includes('Uploaded.') && Date.now() < deadline) await sleep(20);
    assert.match(page.state.doc.toString(), /Uploaded\./);
    assert.equal(page.resets, 1);
    // ... and goes on editing it.
    page.randomEdit(seeded(9));
    await settled([page], srv);
    assert.ok(fs.existsSync(path.join(files, 'logo.png')));

    // The raw route serves what was uploaded, sandboxed.
    const raw = await fetch(`${srv.base}/alice/paper/raw/logo.png`, { headers: { Cookie: bob } });
    assert.equal(raw.headers.get('content-type'), 'image/png');
    assert.match(raw.headers.get('content-security-policy') ?? '', /^sandbox/);
    fs.writeFileSync(path.join(files, 'evil.html'), '<script>alert(1)</script>');
    const html = await fetch(`${srv.base}/alice/paper/raw/evil.html`, { headers: { Cookie: bob } });
    assert.match(html.headers.get('content-type') ?? '', /^text\/plain/);

    // Renaming a file someone has open sends them after it, history and all.
    const before = liveDoc(srv);
    const epoch = before.epoch;
    const version = before.version;
    const moved = await post('/alice/paper/rename/main.tex', { csrf, to: 'paper.tex' });
    assert.equal(moved.status, 303);
    const waitClosed = Date.now() + 5000;
    while (!page.closedWith && Date.now() < waitClosed) await sleep(20);
    assert.deepEqual(page.closedWith, { reason: 'moved', to: '/alice/paper/edit/paper.tex' });
    assert.ok(!fs.existsSync(path.join(files, 'main.tex')));
    const after = srv.docs.get(paperRef(root), 'paper.tex');
    assert.equal(after.epoch, epoch, 'the history moved with the file');
    assert.equal(after.version, version);

    // Deleting tells an open editor it is gone.
    const page2 = await Page.open(srv.base, 'alice', 'chapters/intro.tex');
    open.push(page2);
    await sleep(200);
    assert.equal((await post('/alice/paper/delete/chapters/intro.tex', { csrf })).status, 303);
    const waitDeleted = Date.now() + 5000;
    while (!page2.closedWith && Date.now() < waitDeleted) await sleep(20);
    assert.deepEqual(page2.closedWith, { reason: 'deleted', to: undefined });
    assert.ok(!fs.existsSync(path.join(files, 'chapters')), 'the emptied directory goes too');

    // carol reads: she may download, not change.
    const carol = await signIn(srv.base, 'carol');
    assert.equal((await fetch(`${srv.base}/alice/paper/raw/logo.png`, { headers: { Cookie: carol } })).status, 200);
    assert.equal((await getPage(srv.base, '/alice/paper/new', carol)).status, 403);
  } finally {
    for (const p of open) p.sync.close();
    await srv.stop();
  }
});
