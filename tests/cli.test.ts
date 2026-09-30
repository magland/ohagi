import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { AddressInfo } from 'net';
import { Server } from 'http';
import { createApp } from '../src/server';
import { Docs } from '../src/docs';
import { Compiler } from '../src/compile';
import { History } from '../src/history';
import { EXAMPLE_TOKENS, createExample } from '../scripts/create-example';

// The command line against a running shelf, as a person or a script uses it,
// and the site admin's pages: mochi's user commands and admin routes serving
// ohagi, and ohagi's own collection, project, and collab commands.

const INDEX = path.join(__dirname, '..', 'src', 'index.ts');

async function serve(): Promise<{ root: string; base: string; stop(): Promise<void> }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ohagi-cli-'));
  createExample(root);
  const docs = new Docs();
  const app = createApp(root, docs, new Compiler(), new History(docs));
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    root,
    base,
    stop: async () => {
      docs.flushAll();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    },
  };
}

function cli(base: string, token: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  // A home of its own, so no stored login or credential helper of the
  // machine's is consulted: --host and --token are the whole target.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ohagi-home-'));
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ['--import', 'tsx', INDEX, ...args, '--host', base, '--token', token],
      { env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config') }, cwd: path.join(__dirname, '..') },
      (err, stdout, stderr) => resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr })
    );
  });
}

async function json(base: string, token: string, args: string[]): Promise<Record<string, unknown>> {
  const r = await cli(base, token, [...args, '--json']);
  assert.equal(r.code, 0, `${args.join(' ')}: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

test('users, collections, projects, and collaborators from the command line', async () => {
  const srv = await serve();
  const dev = EXAMPLE_TOKENS.dev;
  try {
    const me = await json(srv.base, dev, ['whoami']);
    assert.equal(me.username, 'dev');
    assert.equal(me.siteAdmin, true);

    // mochi's user add, against ohagi.
    const added = await json(srv.base, dev, ['user', 'add', 'erin']);
    const erin = String(added.token);
    assert.match(erin, /^ohagi_/);
    assert.equal((await json(srv.base, erin, ['whoami'])).username, 'erin');
    const users = (await json(srv.base, dev, ['user', 'list'])).users as { name: string }[];
    assert.deepEqual(users.map((u) => u.name).sort(), ['alice', 'bob', 'carol', 'dev', 'erin']);
    // Someone without the bit cannot.
    assert.notEqual((await cli(srv.base, EXAMPLE_TOKENS.alice, ['user', 'add', 'mallory'])).code, 0);

    // erin makes a project in her own collection, and gives bob write on it.
    const made = await json(srv.base, erin, ['project', 'create', 'erin/notes', '--description', 'Lab notes']);
    assert.equal(made.name, 'notes');
    assert.equal(made.private, true);
    assert.notEqual((await cli(srv.base, erin, ['project', 'create', 'alice/intrusion'])).code, 0);
    await json(srv.base, erin, ['collab', 'add', 'erin/notes', 'bob', '--role', 'write']);
    const bobsProjects = ((await json(srv.base, EXAMPLE_TOKENS.bob, ['project', 'list'])).projects as { collection: string; name: string; role: string }[])
      .map((p) => `${p.collection}/${p.name}:${p.role}`)
      .sort();
    assert.deepEqual(bobsProjects, ['alice/paper:write', 'erin/notes:write', 'lab/proposal:admin']);
    const view = await json(srv.base, EXAMPLE_TOKENS.bob, ['project', 'view', 'erin/notes']);
    assert.deepEqual((view.files as { path: string }[]).map((f) => f.path), ['main.tex']);
    // carol is on nothing of erin's.
    assert.notEqual((await cli(srv.base, EXAMPLE_TOKENS.carol, ['project', 'view', 'erin/notes'])).code, 0);

    // A collection owner holds admin on its projects.
    await json(srv.base, dev, ['collection', 'owner', 'add', 'lab', 'carol']);
    const carolOnLab = (await json(srv.base, EXAMPLE_TOKENS.carol, ['project', 'view', 'lab/proposal'])).role;
    assert.equal(carolOnLab, 'admin');

    // Deleting a user takes their grants with them, so a later erin inherits nothing.
    const deleted = await cli(srv.base, dev, ['user', 'delete', 'bob', '--yes']);
    assert.equal(deleted.code, 0, deleted.stderr);
    const access = JSON.parse(fs.readFileSync(path.join(srv.root, 'collections/alice/projects/paper/access.json'), 'utf8'));
    assert.equal(access.collaborators.bob, undefined);
    assert.equal(access.collaborators.carol, 'read');

    // And a project deleted from the command line is gone.
    assert.notEqual((await cli(srv.base, erin, ['project', 'delete', 'erin/notes'])).code, 0, 'needs --yes');
    await json(srv.base, erin, ['project', 'delete', 'erin/notes', '--yes']);
    assert.ok(!fs.existsSync(path.join(srv.root, 'collections/erin/projects/notes')));
  } finally {
    await srv.stop();
  }
});

test('the site admin’s pages are mochi’s, with the sections a shelf has', async () => {
  const srv = await serve();
  try {
    const signIn = async (user: keyof typeof EXAMPLE_TOKENS) => {
      const res = await fetch(`${srv.base}/login`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ username: user, token: EXAMPLE_TOKENS[user], next: '/' }).toString(),
      });
      return (res.headers.get('set-cookie') ?? '').split(';')[0];
    };
    const dev = await signIn('dev');
    const admin = await (await fetch(`${srv.base}/admin`, { headers: { Cookie: dev } })).text();
    assert.match(admin, /href="\/admin\/users"/);
    assert.match(admin, /href="\/admin\/appearance"/);
    assert.match(admin, /href="\/admin\/github"/);
    assert.doesNotMatch(admin, /\/admin\/runners|\/admin\/egress|\/admin\/settings/);
    assert.equal((await fetch(`${srv.base}/admin/egress`, { headers: { Cookie: dev } })).status, 404);
    const users = await (await fetch(`${srv.base}/admin/users`, { headers: { Cookie: dev } })).text();
    assert.match(users, /carol/);

    const carol = await signIn('carol');
    assert.equal((await fetch(`${srv.base}/admin/users`, { headers: { Cookie: carol } })).status, 403);

    // The account page is mochi's too, in ohagi's clothes.
    const account = await (await fetch(`${srv.base}/account`, { headers: { Cookie: carol } })).text();
    assert.match(account, /aria-label="ohagi"/);
    assert.match(account, /\/assets\/ohagi\.css/);
  } finally {
    await srv.stop();
  }
});

test('file get, put, mv, and rm from the command line', async () => {
  const srv = await serve();
  const bob = EXAMPLE_TOKENS.bob;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ohagi-files-'));
  try {
    const local = path.join(tmp, 'fig.png');
    fs.writeFileSync(local, Buffer.from('89504e470d0a1a0a0001', 'hex'));
    const put = await json(srv.base, bob, ['file', 'put', 'alice/paper', local, '--as', 'figures/fig.png']);
    assert.deepEqual(put, { path: 'figures/fig.png', size: 10 });
    assert.notEqual((await cli(srv.base, bob, ['file', 'put', 'alice/paper', local, '--as', 'figures/fig.png'])).code, 0, 'exists without --overwrite');
    await json(srv.base, bob, ['file', 'mv', 'alice/paper', 'figures/fig.png', 'figures/renamed.png']);
    const got = path.join(tmp, 'back.png');
    const r = await cli(srv.base, bob, ['file', 'get', 'alice/paper', 'figures/renamed.png', '-o', got]);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(fs.readFileSync(got), fs.readFileSync(local));
    await json(srv.base, bob, ['file', 'rm', 'alice/paper', 'figures/renamed.png']);
    assert.notEqual((await cli(srv.base, EXAMPLE_TOKENS.carol, ['file', 'rm', 'alice/paper', 'main.tex'])).code, 0, 'carol only reads');
    assert.ok(fs.existsSync(path.join(srv.root, 'collections/alice/projects/paper/files/main.tex')));
  } finally {
    await srv.stop();
  }
});

test('compile from the command line, by anyone who can read the project', async () => {
  const srv = await serve();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ohagi-pdf-'));
  try {
    const out = path.join(tmp, 'paper.pdf');
    // carol only reads alice/paper, and may still compile it.
    const r = await cli(srv.base, EXAMPLE_TOKENS.carol, ['compile', 'alice/paper', '-o', out]);
    assert.match(r.stdout, /Compiled: alice\/paper \(main\.tex\)/);
    assert.equal(fs.readFileSync(out).subarray(0, 4).toString(), '%PDF');
    // The example cites a .bib it never runs bibtex on to completion; any
    // warnings are fine, errors are not.
    assert.equal(r.code, 0, r.stdout + r.stderr);
    // A broken document exits non-zero and says where.
    fs.writeFileSync(path.join(srv.root, 'collections/alice/projects/paper/files/main.tex'), '\\documentclass{article}\\begin{document}\n\\oops\n\\end{document}\n');
    const bad = await cli(srv.base, EXAMPLE_TOKENS.bob, ['compile', 'alice/paper']);
    assert.notEqual(bad.code, 0);
    assert.match(bad.stdout, /main\.tex:2: Undefined control sequence/);
  } finally {
    await srv.stop();
  }
});

test('backup copies a shelf over HTTP, without what a compile left', async () => {
  const srv = await serve();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ohagi-backup-'));
  try {
    const compiled = await cli(srv.base, EXAMPLE_TOKENS.alice, ['compile', 'alice/paper']);
    assert.equal(compiled.code, 0, compiled.stdout + compiled.stderr);
    assert.ok(fs.existsSync(path.join(srv.root, 'collections/alice/projects/paper/build')));
    // Only a site admin may take the whole shelf.
    assert.notEqual((await cli(srv.base, EXAMPLE_TOKENS.alice, ['backup', dir])).code, 0);
    const r = await cli(srv.base, EXAMPLE_TOKENS.dev, ['backup', dir]);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    const current = path.join(dir, 'current');
    assert.ok(fs.existsSync(path.join(current, 'shelf.json')));
    assert.ok(fs.existsSync(path.join(current, '.secret')) || !fs.existsSync(path.join(srv.root, '.secret')));
    assert.equal(
      fs.readFileSync(path.join(current, 'collections/alice/projects/paper/files/main.tex'), 'utf8'),
      fs.readFileSync(path.join(srv.root, 'collections/alice/projects/paper/files/main.tex'), 'utf8')
    );
    assert.ok(fs.existsSync(path.join(current, 'collections/alice/projects/paper/access.json')));
    assert.ok(!fs.existsSync(path.join(current, 'collections/alice/projects/paper/build')), 'build/ is left out');
    const verify = await cli(srv.base, EXAMPLE_TOKENS.dev, ['backup', 'verify', dir]);
    assert.equal(verify.code, 0, verify.stdout + verify.stderr);
  } finally {
    await srv.stop();
  }
});

test('git clone of a project: members only, read-only, and current', async () => {
  const srv = await serve();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ohagi-clone-'));
  const git = (args: string[], cwd = tmp) =>
    new Promise<{ code: number; out: string }>((resolve) =>
      execFile('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_GLOBAL: '/dev/null' } }, (err, stdout, stderr) =>
        resolve({ code: err ? 1 : 0, out: stdout + stderr })
      )
    );
  const url = (user: keyof typeof EXAMPLE_TOKENS, project = 'alice/paper') =>
    srv.base.replace('http://', `http://${user}:${EXAMPLE_TOKENS[user]}@`) + `/${project}`;
  try {
    // bob edits main.tex through the file API, then carol, who reads, clones.
    const put = await fetch(`${srv.base}/api/projects/alice/paper/raw?path=main.tex&overwrite=1`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${EXAMPLE_TOKENS.bob}`, 'Content-Type': 'application/octet-stream' },
      body: '\\documentclass{article}\\begin{document}Edited by bob.\\end{document}\n',
    });
    assert.equal(put.status, 200);
    const cloned = await git(['clone', '-q', url('carol'), 'paper']);
    assert.equal(cloned.code, 0, cloned.out);
    assert.match(fs.readFileSync(path.join(tmp, 'paper/main.tex'), 'utf8'), /Edited by bob\./);
    assert.ok(fs.existsSync(path.join(tmp, 'paper/refs.bib')));
    const log = await git(['log', '--format=%an|%s'], path.join(tmp, 'paper'));
    assert.match(log.out.split('\n')[0], /^bob\|Edits by bob$/);

    // A push is refused, with a sentence.
    fs.writeFileSync(path.join(tmp, 'paper/new.tex'), 'x');
    await git(['-c', 'user.name=c', '-c', 'user.email=c@x', 'commit', '-qam', 'try'], path.join(tmp, 'paper'));
    await git(['add', '.'], path.join(tmp, 'paper'));
    const pushed = await git(['push', '-q', 'origin', 'HEAD'], path.join(tmp, 'paper'));
    assert.notEqual(pushed.code, 0);
    assert.match(pushed.out, /read-only/);

    // alice is not on lab/proposal: it answers as if absent. No credential: git is asked for one.
    const stranger = await git(['clone', '-q', url('alice', 'lab/proposal'), 'proposal']);
    assert.notEqual(stranger.code, 0);
    assert.match(stranger.out, /not found/);
    const anon = await git(['clone', '-q', `${srv.base}/alice/paper`, 'anon']);
    assert.notEqual(anon.code, 0);

    // A pull after more editing brings it.
    fs.writeFileSync(path.join(srv.root, 'collections/alice/projects/paper/files/results.tex'), 'Newer results.\n');
    await git(['reset', '-q', '--hard', 'origin/main'], path.join(tmp, 'paper'));
    await git(['clean', '-qfd'], path.join(tmp, 'paper'));
    const again = await git(['pull', '-q', '--ff-only'], path.join(tmp, 'paper'));
    assert.equal(again.code, 0, again.out);
    assert.equal(fs.readFileSync(path.join(tmp, 'paper/results.tex'), 'utf8'), 'Newer results.\n');
  } finally {
    await srv.stop();
  }
});
