import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { Compiler, bubblewrapWorks, parseLog, synctexEdit } from '../src/compile';
import { createProject, filesDir } from '../src/projects';

// Compiling, against the TeX Live on this machine: a document compiles, its
// errors are found, and a document that tries to reach past its own files,
// or to run a command, gets nothing. Skipped where there is no latexmk.

const hasTeX = (() => {
  try {
    execFileSync('latexmk', ['-v'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

function shelfWith(files: Record<string, string> | ((root: string) => Record<string, string>)) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ohagi-compile-'));
  if (typeof files === 'function') files = files(root);
  fs.writeFileSync(path.join(root, 'shelf.json'), '{"secret": "SHELF-SECRET-MARKER"}\n');
  const ref = createProject(root, 'alice', 'doc');
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(filesDir(ref.dir), rel)), { recursive: true });
    fs.writeFileSync(path.join(filesDir(ref.dir), rel), text);
  }
  return { root, ref };
}

const doc = (body: string) => `\\documentclass{article}\n\\begin{document}\n${body}\n\\end{document}\n`;

function pdfText(file: string): string {
  try {
    return execFileSync('pdftotext', [file, '-'], { encoding: 'utf8' });
  } catch {
    return fs.readFileSync(file, 'latin1');
  }
}

// bubblewrap needs unprivileged user namespaces, which some machines (CI
// runners among them) do not allow; its tests are skipped there, and the
// same checks run without it.
const hasBwrap = hasTeX && bubblewrapWorks();

for (const sandbox of ['bubblewrap', 'none'] as const) {
  const skip = !hasTeX || (sandbox === 'bubblewrap' && !hasBwrap);
  test(`a document compiles, and its errors are found (sandbox: ${sandbox})`, { skip }, async () => {
    const c = new Compiler({ sandbox });
    const { ref } = shelfWith({ 'main.tex': doc('Hello from \\input{chapters/one}.'), 'chapters/one.tex': 'chapter one' });
    const ok = await c.compile(ref);
    assert.equal(ok.status, 'success', ok.log.slice(-2000));
    assert.ok(ok.pdf);
    assert.match(pdfText(path.join(ref.dir, 'build/src/main.pdf')), /chapter one/);
    // files/ is untouched: nothing a compile writes lands there.
    assert.deepEqual(fs.readdirSync(filesDir(ref.dir)).sort(), ['chapters', 'main.tex']);
    // A file removed from the project is removed from the next compile's copy.
    fs.rmSync(path.join(filesDir(ref.dir), 'chapters/one.tex'));
    fs.writeFileSync(path.join(filesDir(ref.dir), 'main.tex'), doc('No chapter.'));
    await c.compile(ref);
    assert.ok(!fs.existsSync(path.join(ref.dir, 'build/src/chapters/one.tex')));

    fs.writeFileSync(path.join(filesDir(ref.dir), 'main.tex'), doc('Line two.\n\\undefinedthing\nLine four.'));
    const bad = await c.compile(ref);
    assert.equal(bad.status, 'failure');
    assert.deepEqual(
      bad.errors.map((e) => [e.file, e.line]),
      [['main.tex', 4]]
    );
    assert.match(bad.errors[0].message, /Undefined control sequence/);
    assert.ok(bad.pdf, 'a PDF is produced despite the error');
  });

  test(`a document cannot read the shelf, the system, or run a command (sandbox: ${sandbox})`, { skip }, async () => {
    const c = new Compiler({ sandbox });
    const { ref } = shelfWith((root) => ({
      'main.tex': doc(
        [
          // By absolute path, by climbing out, and by shell escape.
          `\\IfFileExists{${path.join(root, 'shelf.json')}}{ABSOLUTE-READ}{absolute-refused}`,
          '\\IfFileExists{../../../../../../shelf.json}{CLIMBED-READ}{climb-refused}',
          '\\IfFileExists{/etc/hostname}{ETC-READ}{etc-refused}',
          '\\immediate\\write18{touch /tmp/ohagi-write18-ran}',
          'done',
        ].join('\n\n')
      ),
    }));
    fs.rmSync('/tmp/ohagi-write18-ran', { force: true });
    const r = await c.compile(ref);
    assert.ok(r.pdf, r.log.slice(-2000));
    const text = pdfText(path.join(ref.dir, 'build/src/main.pdf'));
    assert.match(text, /absolute-refused/);
    assert.match(text, /climb-refused/);
    assert.match(text, /etc-refused/);
    assert.doesNotMatch(text, /SHELF-SECRET-MARKER|ABSOLUTE-READ|CLIMBED-READ|ETC-READ/);
    assert.ok(!fs.existsSync('/tmp/ohagi-write18-ran'), 'shell escape ran');
  });
}

test('lualatex cannot open files outside the project from Lua, inside the sandbox', { skip: !hasBwrap }, async () => {
  const c = new Compiler({ sandbox: 'bubblewrap' });
  if (c.sandbox !== 'bubblewrap') return;
  const { ref } = shelfWith((root) => ({
    'main.tex': doc(`\\directlua{local f = io.open("${path.join(root, 'shelf.json')}") tex.print(f and "LUA-READ" or "lua-refused")}`),
  }));
  fs.writeFileSync(path.join(ref.dir, 'project.json'), JSON.stringify({ description: '', created: null, engine: 'lualatex' }));
  const r = await c.compile(ref, 'lualatex');
  assert.ok(r.pdf, r.log.slice(-2000));
  const text = pdfText(path.join(ref.dir, 'build/src/main.pdf'));
  assert.match(text, /lua-refused/);
  assert.doesNotMatch(text, /LUA-READ/);
});

for (const sandbox of ['bubblewrap', 'none'] as const) {
  test(`SyncTeX maps a point on the PDF back to the file and line (sandbox: ${sandbox})`, { skip: !hasTeX || (sandbox === 'bubblewrap' && !hasBwrap) }, async () => {
    const c = new Compiler({ sandbox });
    const { ref } = shelfWith({
      'main.tex': doc('First paragraph, in main.\n\n\\input{chapters/two}\n\nLast paragraph.'),
      'chapters/two.tex': 'An opening line.\n\nA second paragraph, in the chapter file.\n',
    });
    const r = await c.compile(ref);
    assert.equal(r.status, 'success', r.log.slice(-2000));
    // Where TeX put line 3 of the chapter file, asked the other way round.
    const src = path.join(ref.dir, 'build/src');
    const view = execFileSync('synctex', ['view', '-i', '3:1:chapters/two.tex', '-o', 'main.pdf'], { cwd: src, encoding: 'utf8' });
    const page = Number(/^Page:(\d+)$/m.exec(view)![1]);
    const x = Number(/^x:([\d.]+)$/m.exec(view)![1]);
    const y = Number(/^y:([\d.]+)$/m.exec(view)![1]);
    const spot = await synctexEdit(ref, c.sandbox, 'main.tex', page, x + 5, y - 3);
    assert.deepEqual(spot, { file: 'chapters/two.tex', line: 3 });
    // A point in the margin, where nothing was typeset, maps to nothing of the project's.
    const nowhere = await synctexEdit(ref, c.sandbox, 'main.tex', 1, 2, 2);
    assert.ok(nowhere === null || nowhere.file === 'main.tex');
  });
}

test('lualatex is refused without the sandbox', { skip: !hasTeX }, async () => {
  const c = new Compiler({ sandbox: 'none' });
  const { ref } = shelfWith({ 'main.tex': doc('x') });
  const r = await c.compile(ref, 'lualatex');
  assert.equal(r.status, 'error');
  assert.match(r.errors[0].message, /lualatex runs only where/);
});

test('a compile that runs too long is stopped', { skip: !hasTeX }, async () => {
  const c = new Compiler({ timeoutMs: 3000 });
  const { ref } = shelfWith({ 'main.tex': doc('\\def\\loop{\\loop}\\loop') });
  const r = await c.compile(ref);
  assert.equal(r.status, 'timeout');
  assert.ok(r.durationMs < 10000);
});

test('the log parser finds file:line errors, and ! lines when there are none', () => {
  const a = parseLog('./main.tex:12: Undefined control sequence.\nsomething\n./chapters/b.tex:3: Missing $ inserted.\n');
  assert.deepEqual(
    a.errors.map((e) => [e.file, e.line]),
    [
      ['main.tex', 12],
      ['chapters/b.tex', 3],
    ]
  );
  const b = parseLog('! Emergency stop.\nLaTeX Warning: Reference `x\' undefined.\n');
  assert.deepEqual(b.errors, [{ file: null, line: null, message: 'Emergency stop.' }]);
  assert.equal(b.warnings, 1);
});
