import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AddressInfo } from 'net';
import { Server } from 'http';
import { EditorState, Transaction } from '@codemirror/state';
import { collab, getClientID, sendableUpdates } from '@codemirror/collab';
import { createApp } from '../src/server';
import { Docs } from '../src/docs';
import { Compiler } from '../src/compile';
import { History, repoDir } from '../src/history';
import { filesDir, findProject } from '../src/projects';
import { recordingFile, setPatterns } from '../src/recording';
import { Sync } from '../client/sync';
import { EXAMPLE_TOKENS, createExample } from '../scripts/create-example';
import { parseLog } from '../../arewehuman/src/prov/log';
import { verifyChain } from '../../arewehuman/src/prov/chain';
import { replay } from '../../arewehuman/src/prov/replay';
import { attribute } from '../../arewehuman/src/prov/attribute';

// Recording how a project is written, with arewehuman (src/recording.ts):
// pages running the browser's sync code describe their edits as the editor
// page does (client/awh.ts), and the server records them with their authors.

type User = keyof typeof EXAMPLE_TOKENS;
const auth = (u: User) => ({ Authorization: `Bearer ${EXAMPLE_TOKENS[u]}` });

async function serve() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ohagi-awh-'));
  createExample(root);
  const docs = new Docs();
  const history = new History(docs);
  const app = createApp(root, docs, new Compiler(), history);
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const ref = findProject(root, 'alice', 'paper')!;
  return {
    root,
    docs,
    history,
    base,
    ref,
    stop: async () => {
      docs.flushAll();
      await docs.settle(ref.dir);
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    },
  };
}

/** A page of the editor: the browser's sync code, with edits described as client/awh.ts describes them. */
class Page {
  state: EditorState;
  sync: Sync;
  private meta = new WeakMap<Transaction, object>();

  constructor(base: string, first: { epoch: string; version: number; doc: string }, user: User, file: string) {
    this.state = EditorState.create({ doc: first.doc, extensions: [collab({ startVersion: first.version })] });
    const clientID = getClientID(this.state);
    this.sync = new Sync(
      {
        state: () => this.state,
        dispatch: (tr: Transaction) => {
          this.state = tr.state;
        },
        reset: (doc, version) => {
          this.state = EditorState.create({ doc, extensions: [collab({ startVersion: version, clientID })] });
        },
        describe: (tr) => this.meta.get(tr),
      },
      { base, collection: 'alice', project: 'paper', path: file, epoch: first.epoch, headers: auth(user) },
    );
    this.sync.start();
  }

  static async open(base: string, user: User, file = 'main.tex'): Promise<Page> {
    const first = await (await fetch(`${base}/api/projects/alice/paper/doc?path=${encodeURIComponent(file)}`, { headers: auth(user) })).json();
    return new Page(base, first, user, file);
  }

  edit(changes: { from: number; to?: number; insert?: string }, userEvent: string, meta: object): void {
    const tr = this.state.update({ changes, userEvent });
    this.meta.set(tr, { t: Date.now(), ...meta });
    this.state = tr.state;
    this.sync.changed();
  }

  /** Type text at `at`, a character at a time, as keystrokes. */
  type(at: number, s: string): void {
    for (const ch of s) this.edit({ from: at++, insert: ch }, 'input.type', { cause: 'typed' });
  }

  async synced(): Promise<void> {
    for (let i = 0; i < 400 && sendableUpdates(this.state).length; i++) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 100));
  }

  close(): void {
    this.sync.close();
  }
}

async function recordingOf(srv: Awaited<ReturnType<typeof serve>>, rel: string) {
  srv.docs.flushProject(srv.ref.dir);
  await srv.docs.settle(srv.ref.dir);
  const doc = parseLog(fs.readFileSync(recordingFile(srv.ref, rel), 'utf8')).doc;
  assert.deepEqual(replay(doc).errors, []);
  assert.ok((await verifyChain(doc)).ok, 'hash chain intact');
  return doc;
}

function setUp(srv: Awaited<ReturnType<typeof serve>>, list = ['*.tex']) {
  setPatterns(srv.ref, list);
  srv.docs.refreshRecordings(srv.ref);
}

test('two people typing into one file share its recording, each credited with what they typed', async () => {
  const srv = await serve();
  try {
    setUp(srv);
    const a = await Page.open(srv.base, 'alice');
    const b = await Page.open(srv.base, 'bob');
    a.type(0, 'Alice typed this. ');
    await a.synced();
    await b.synced();
    b.type(b.state.doc.length, '\nBob typed this.');
    await b.synced();
    await a.synced();
    const doc = await recordingOf(srv, 'main.tex');
    const text = fs.readFileSync(path.join(filesDir(srv.ref.dir), 'main.tex'), 'utf8');
    assert.equal(doc.text, text);
    assert.deepEqual(
      doc.events.filter((e) => e[0] === 'a').map((e) => e[2]),
      ['alice', 'bob'],
    );
    const origins = attribute(text, [doc]);
    const who = (s: string) => new Set(origins.slice(text.indexOf(s), text.indexOf(s) + s.length).map((o) => `${o?.author}/${o?.src}`));
    assert.deepEqual(who('Alice typed this.'), new Set(['alice/t']));
    assert.deepEqual(who('Bob typed this.'), new Set(['bob/t']));
    assert.deepEqual(who('\\documentclass'), new Set(['undefined/x'])); // there before recording started
    a.close();
    b.close();
  } finally {
    await srv.stop();
  }
});

test('a cut pasted back is a move, and a copy pasted into another file refers to where it came from', async () => {
  const srv = await serve();
  try {
    setUp(srv);
    const a = await Page.open(srv.base, 'alice');
    a.type(0, 'First sentence. Second sentence. ');
    await a.synced();
    // Cut "Second sentence. " and paste it at the start: a move, with the same characters.
    const from = a.state.doc.toString().indexOf('Second');
    const to = from + 'Second sentence. '.length;
    const cut = 'cut-nonce-1';
    a.edit({ from, to }, 'delete.cut', { cause: 'other', clip: cut });
    await a.synced();
    a.edit({ from: 0, insert: 'Second sentence. ' }, 'input.paste', { cause: 'paste', nonce: cut });
    await a.synced();
    const one = await recordingOf(srv, 'main.tex');
    assert.ok(
      one.events.some((e) => e[0] === 'r' && e[3] === 'm'),
      'the paste restored the cut characters',
    );
    // Copy "First sentence." in main.tex and paste it into results.tex.
    const copy = 'copy-nonce-1';
    const at = a.state.doc.toString().indexOf('First sentence.');
    a.sync.registerCopy(copy, [{ from: at, to: at + 'First sentence.'.length }]);
    await new Promise((r) => setTimeout(r, 200));
    const r = await Page.open(srv.base, 'alice', 'results.tex');
    r.edit({ from: 0, insert: 'First sentence.' }, 'input.paste', { cause: 'paste', nonce: copy });
    await r.synced();
    const two = await recordingOf(srv, 'results.tex');
    const k = two.events.find((e) => e[0] === 'k');
    assert.ok(k, 'the paste refers to main.tex');
    assert.equal(k![3], one.id);
    const text = fs.readFileSync(path.join(filesDir(srv.ref.dir), 'results.tex'), 'utf8');
    const origins = attribute(text, [two, one]);
    assert.ok(origins.slice(0, 15).every((o) => o?.rec === 1 && o.src === 't' && o.author === 'alice'));
    // An unknown nonce is an ordinary paste.
    r.edit({ from: 0, insert: 'From elsewhere. ' }, 'input.paste', { cause: 'paste', nonce: 'nobody-knows' });
    await r.synced();
    const three = await recordingOf(srv, 'results.tex');
    assert.equal(three.events[three.events.length - 1][4], 'p');
    a.close();
    r.close();
  } finally {
    await srv.stop();
  }
});

test('uploads, renames, deletions, and commits carry the recording along', async () => {
  const srv = await serve();
  try {
    setUp(srv);
    const a = await Page.open(srv.base, 'alice');
    a.type(0, '% typed\n');
    await a.synced();
    // An upload over the open file: the difference, by the uploader.
    const now = fs.readFileSync(path.join(filesDir(srv.ref.dir), 'main.tex'), 'utf8');
    const res = await fetch(`${srv.base}/api/projects/alice/paper/raw?path=main.tex&overwrite=1`, {
      method: 'PUT',
      headers: auth('bob'),
      body: now + '% uploaded\n',
    });
    assert.equal(res.status, 200);
    const up = await recordingOf(srv, 'main.tex');
    assert.equal(up.events.filter((e) => e[0] === 'a').pop()![2], 'bob');
    assert.ok(up.text.endsWith('% uploaded\n'));
    // A commit includes the recording.
    await srv.history.commitNow(srv.ref);
    const tracked = execFileSync('git', ['--git-dir', repoDir(srv.ref), 'ls-tree', '-r', '--name-only', 'HEAD'], { encoding: 'utf8' });
    assert.match(tracked, /^\.arewehuman\/main\.tex\/ohagi\.awh\.jsonl$/m);
    assert.match(tracked, /^\.arewehuman\/config\.json$/m);
    // Rename: the recording moves; the file stays recorded under its new name.
    a.close();
    const mv = await fetch(`${srv.base}/api/projects/alice/paper/rename`, {
      method: 'POST',
      headers: { ...auth('alice'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'main.tex', to: 'paper.tex' }),
    });
    assert.equal(mv.status, 200);
    assert.ok(!fs.existsSync(recordingFile(srv.ref, 'main.tex')));
    assert.ok(fs.existsSync(recordingFile(srv.ref, 'paper.tex')));
    const p = await Page.open(srv.base, 'alice', 'paper.tex');
    p.type(0, 'x');
    await p.synced();
    const moved = await recordingOf(srv, 'paper.tex');
    assert.equal(moved.id, up.id);
    p.close();
    // Who wrote what: the file's recordings, and the project's others.
    await Page.open(srv.base, 'alice', 'results.tex').then(async (r) => {
      r.type(0, 'y');
      await r.synced();
      r.close();
    });
    const rec = await (await fetch(`${srv.base}/api/projects/alice/paper/awh/record?path=paper.tex`, { headers: auth('carol') })).json();
    assert.deepEqual(
      rec.recs.map((r: { name: string }) => r.name),
      ['ohagi'],
    );
    assert.deepEqual(
      rec.others.map((r: { name: string }) => r.name),
      ['results.tex · ohagi'],
    );
    assert.equal(rec.text, fs.readFileSync(path.join(filesDir(srv.ref.dir), 'paper.tex'), 'utf8'));
    // Delete: the recording goes too.
    const del = await fetch(`${srv.base}/api/projects/alice/paper/raw?path=paper.tex`, { method: 'DELETE', headers: auth('alice') });
    assert.equal(del.status, 200);
    assert.ok(!fs.existsSync(path.join(filesDir(srv.ref.dir), '.arewehuman', 'paper.tex')));
  } finally {
    await srv.stop();
  }
});

test('a project that does not record keeps no recordings, and a file opened before set-up is recorded once it is', async () => {
  const srv = await serve();
  try {
    const a = await Page.open(srv.base, 'alice');
    a.type(0, 'not recorded ');
    await a.synced();
    srv.docs.flushProject(srv.ref.dir);
    assert.ok(!fs.existsSync(path.join(filesDir(srv.ref.dir), '.arewehuman')));
    setUp(srv, ['main.tex']);
    a.type(0, 'recorded ');
    await a.synced();
    const doc = await recordingOf(srv, 'main.tex');
    assert.ok(doc.text.startsWith('recorded not recorded '));
    // Only the patterns' files are recorded.
    const r = await Page.open(srv.base, 'alice', 'results.tex');
    r.type(0, 'z');
    await r.synced();
    srv.docs.flushProject(srv.ref.dir);
    await srv.docs.settle(srv.ref.dir);
    assert.ok(!fs.existsSync(recordingFile(srv.ref, 'results.tex')));
    a.close();
    r.close();
  } finally {
    await srv.stop();
  }
});

