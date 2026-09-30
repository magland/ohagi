import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Engine, ProjectRef, filesDir, listFiles } from './projects';

export type { Engine };

// Compiling a project to PDF: latexmk, in a sandbox, on a copy of the files.
//
// A compile works in <project>/build/src/, a copy of files/ brought up to
// date before each run (files deleted from the project are deleted from it),
// where latexmk writes beside the sources: the PDF, the log, and the
// auxiliary files it reuses from one run to the next. files/ itself is never
// touched, so a compile can neither change a project nor leave anything in
// it. There is deliberately no -outdir: given an output directory, TeX also
// looks for every input file under it, and that joined path is not held to
// openin_any, so ../../../shelf.json read through build/out/ escaped the
// paranoid setting below. The tests keep that door shut.
//
// The document is untrusted input: anyone who can write a project can make
// TeX run whatever the document says. Three things hold it in.
//
//  - TeX's own settings, always: no shell escape, and openin_any and
//    openout_any set to paranoid, so a document can neither run a command
//    nor read or write a file by an absolute path or one that climbs out of
//    the directory. TeX Live's default lets a document \input any file the
//    process can read, the shelf's shelf.json and .secret among them.
//    lualatex is the exception: its paranoid mode refuses the absolute paths
//    of TeX's own system files too, which pdfTeX and XeTeX exempt, so it
//    runs with the restricted setting (no dot-files) and relies on the
//    namespace below, and is refused where there is no namespace.
//  - bubblewrap, where it can run: a mount namespace in which the system is
//    read-only, the only writable place is the build directory, the shelf is
//    not there at all, and there is no network. lualatex's Lua can open
//    files without asking TeX, which the settings above do not cover and the
//    namespace does.
//  - Limits: a wall-clock timeout that kills the whole process group, and a
//    cap on address space and CPU time through prlimit.
//
// A machine where bubblewrap cannot run (no unprivileged user namespaces)
// compiles with the first and third only, and says so when the server starts.

export interface CompileError {
  file: string | null;
  line: number | null;
  message: string;
}

export interface CompileResult {
  status: 'success' | 'failure' | 'timeout' | 'error';
  /** The file compiled, relative to the project. */
  main: string;
  engine: Engine;
  errors: CompileError[];
  warnings: number;
  /** The end of latexmk's own output and the TeX log, for reading when the errors do not say enough. */
  log: string;
  pdf: boolean;
  durationMs: number;
  finished: string;
  sandbox: 'bubblewrap' | 'none';
}

const ENGINE_FLAG: Record<Engine, string> = { pdflatex: '-pdf', xelatex: '-xelatex', lualatex: '-lualatex' };

export interface CompilerOptions {
  timeoutMs?: number;
  /** Compiles running at once across the shelf; the rest wait their turn. */
  concurrency?: number;
  /** Address-space cap for the compile, in bytes. */
  memoryBytes?: number;
  /** Force the sandbox on or off; by default it is used when it works. */
  sandbox?: 'auto' | 'bubblewrap' | 'none';
}

const LOG_TAIL = 64 * 1024;

export function buildDir(ref: ProjectRef): string {
  return path.join(ref.dir, 'build');
}

export function pdfPath(ref: ProjectRef, main: string): string {
  return path.join(buildDir(ref), 'src', main.replace(/\.tex$/, '') + '.pdf');
}

/**
 * Bring build/src up to date with files/: every project file copied over,
 * and every file copied last time that the project no longer has removed.
 * What latexmk wrote there itself is left alone, which is what lets it
 * reuse its work.
 */
function syncSources(ref: ProjectRef, src: string): void {
  const manifestFile = path.join(buildDir(ref), 'sources.json');
  let previous: string[] = [];
  try {
    previous = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  } catch {
    previous = [];
  }
  const current = listFiles(ref).map((f) => f.path);
  const keep = new Set(current);
  for (const rel of previous) if (!keep.has(rel)) fs.rmSync(path.join(src, rel), { force: true });
  for (const rel of current) {
    const to = path.join(src, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(filesDir(ref.dir), rel), to);
  }
  fs.writeFileSync(manifestFile, JSON.stringify(current));
}

/**
 * The file to compile: main.tex when there is one, else the first .tex file
 * at the top of the project that declares a \documentclass, else null.
 */
export function mainFile(ref: ProjectRef): string | null {
  const files = listFiles(ref).filter((f) => f.text && f.path.endsWith('.tex'));
  if (files.some((f) => f.path === 'main.tex')) return 'main.tex';
  for (const f of files) {
    if (f.path.includes('/')) continue;
    try {
      const head = fs.readFileSync(path.join(filesDir(ref.dir), f.path), 'utf8').slice(0, 20000);
      if (/^[^%\n]*\\documentclass/m.test(head)) return f.path;
    } catch {
      // unreadable; not the one
    }
  }
  return null;
}

/** Whether bubblewrap can make the namespace this machine would compile in. */
function bubblewrapWorks(): boolean {
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'ohagi-bwrap-'));
  try {
    fs.mkdirSync(path.join(probe, 'src'));
    const r = spawnSync('bwrap', [...sandboxArgs(probe), 'true'], { timeout: 10000, stdio: 'ignore' });
    return r.status === 0;
  } catch {
    return false;
  } finally {
    fs.rmSync(probe, { recursive: true, force: true });
  }
}

/**
 * The namespace: the system read-only (merged-/usr and split layouts alike),
 * the TeX Live trees Debian keeps in /var/lib, a private /tmp, and the build
 * directory as /work, the one writable place. Nothing is shared with the host
 * beyond that: no network, no other processes, no IPC.
 */
function sandboxArgs(work: string): string[] {
  const args = ['--ro-bind', '/usr', '/usr'];
  // Of /etc, only what TeX, its fonts, and the dynamic linker read: not the
  // host's accounts, keys, or anything else a document has no business with.
  for (const p of ['/etc/texmf', '/etc/fonts', '/etc/ld.so.cache', '/etc/alternatives', '/etc/perl', '/etc/papersize']) {
    if (fs.existsSync(p)) args.push('--ro-bind', p, p);
  }
  for (const d of ['bin', 'lib', 'lib64', 'sbin']) {
    const p = `/${d}`;
    let st: fs.Stats | null = null;
    try {
      st = fs.lstatSync(p);
    } catch {
      st = null;
    }
    if (!st) continue;
    if (st.isSymbolicLink()) args.push('--symlink', fs.readlinkSync(p), p);
    else args.push('--ro-bind', p, p);
  }
  for (const p of ['/var/lib/texmf', '/opt/texlive', '/usr/local/texlive']) {
    if (fs.existsSync(p)) args.push('--ro-bind', p, p);
  }
  args.push(
    '--proc', '/proc',
    '--dev', '/dev',
    '--tmpfs', '/tmp',
    '--bind', work, '/work',
    '--chdir', '/work/src',
    '--unshare-all',
    '--die-with-parent',
    '--new-session'
  );
  return args;
}

/** TeX's own locks, for every compile, sandboxed or not. */
function texEnv(home: string, varDir: string, engine: Engine): NodeJS.ProcessEnv {
  const reading = engine === 'lualatex' ? 'r' : 'p';
  return {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    HOME: home,
    LANG: 'C.UTF-8',
    openin_any: reading,
    openout_any: 'p',
    shell_escape: 'f',
    TEXMFVAR: varDir,
    TEXMFCACHE: varDir,
    // latexmk reads ~/.latexmkrc and ./latexmkrc; a project's latexmkrc is
    // Perl, so it is not read either (see -norc below).
  };
}

/** file:line: message, from -file-line-error, and the ! lines TeX writes when it cannot say where. */
export function parseLog(log: string): { errors: CompileError[]; warnings: number } {
  const errors: CompileError[] = [];
  const seen = new Set<string>();
  const lines = log.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^(?:\.\/)?([^:\s][^:]*\.(?:tex|sty|cls|bib|bbl|ltx|dtx|def)):(\d+): (.*)$/.exec(lines[i]);
    if (m && !/==> Fatal error occurred/.test(m[3])) {
      const key = `${m[1]}:${m[2]}:${m[3]}`;
      if (!seen.has(key)) {
        seen.add(key);
        errors.push({ file: m[1].replace(/^\/work\/src\//, ''), line: parseInt(m[2], 10), message: m[3].trim() });
      }
    }
  }
  if (!errors.length) {
    for (const l of lines) {
      if (l.startsWith('! ') && !seen.has(l)) {
        seen.add(l);
        errors.push({ file: null, line: null, message: l.slice(2).trim() });
      }
    }
  }
  const warnings = lines.filter((l) => /(LaTeX|Package \S+) Warning:/.test(l)).length;
  return { errors: errors.slice(0, 50), warnings };
}

export class Compiler {
  readonly sandbox: 'bubblewrap' | 'none';
  private readonly timeoutMs: number;
  private readonly memoryBytes: number;
  private readonly concurrency: number;
  private running = 0;
  private readonly waiting: (() => void)[] = [];
  /** One compile per project at a time; a request during one waits for the next. */
  private readonly inFlight = new Map<string, Promise<CompileResult>>();
  private readonly queued = new Map<string, Promise<CompileResult>>();
  private readonly listeners = new Set<(ref: ProjectRef, result: CompileResult) => void>();

  constructor(opts: CompilerOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? 90_000;
    this.memoryBytes = opts.memoryBytes ?? 2 * 1024 * 1024 * 1024;
    this.concurrency = opts.concurrency ?? 2;
    const want = opts.sandbox ?? 'auto';
    this.sandbox = want === 'none' ? 'none' : want === 'bubblewrap' || bubblewrapWorks() ? 'bubblewrap' : 'none';
  }

  onCompiled(fn: (ref: ProjectRef, result: CompileResult) => void): void {
    this.listeners.add(fn);
  }

  /** The last result, if the project has been compiled. */
  lastResult(ref: ProjectRef): CompileResult | null {
    try {
      return JSON.parse(fs.readFileSync(path.join(buildDir(ref), 'result.json'), 'utf8'));
    } catch {
      return null;
    }
  }

  /**
   * Compile the project. A request while one is running waits for it and then
   * runs once more (however many asked meanwhile), so the files it copies are
   * at least as new as the request.
   */
  compile(ref: ProjectRef, engine: Engine = 'pdflatex'): Promise<CompileResult> {
    const key = ref.dir;
    const running = this.inFlight.get(key);
    if (!running) return this.start(ref, engine);
    const waiting = this.queued.get(key);
    if (waiting) return waiting;
    const next = running.catch(() => null).then(() => {
      this.queued.delete(key);
      return this.start(ref, engine);
    });
    this.queued.set(key, next);
    return next;
  }

  private start(ref: ProjectRef, engine: Engine): Promise<CompileResult> {
    const p = this.withSlot(() => this.run(ref, engine)).finally(() => {
      if (this.inFlight.get(ref.dir) === p) this.inFlight.delete(ref.dir);
    });
    this.inFlight.set(ref.dir, p);
    return p;
  }

  private async withSlot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.running >= this.concurrency) await new Promise<void>((r) => this.waiting.push(r));
    this.running++;
    try {
      return await fn();
    } finally {
      this.running--;
      this.waiting.shift()?.();
    }
  }

  private async run(ref: ProjectRef, engine: Engine): Promise<CompileResult> {
    const started = Date.now();
    const build = buildDir(ref);
    const src = path.join(build, 'src');
    const main = mainFile(ref);
    const finish = (r: Omit<CompileResult, 'durationMs' | 'finished' | 'sandbox' | 'engine'>): CompileResult => {
      const result: CompileResult = { ...r, engine, durationMs: Date.now() - started, finished: new Date().toISOString(), sandbox: this.sandbox };
      fs.mkdirSync(build, { recursive: true });
      fs.writeFileSync(path.join(build, 'result.json'), JSON.stringify(result) + '\n');
      for (const fn of this.listeners) fn(ref, result);
      return result;
    };
    if (!main) {
      return finish({
        status: 'error',
        main: '',
        errors: [{ file: null, line: null, message: 'There is no main.tex, and no .tex file at the top of the project declares a \\documentclass.' }],
        warnings: 0,
        log: '',
        pdf: false,
      });
    }
    if (engine === 'lualatex' && this.sandbox !== 'bubblewrap') {
      return finish({
        status: 'error',
        main,
        errors: [{ file: null, line: null, message: 'lualatex runs only where the compile sandbox (bubblewrap) is available; use pdflatex or xelatex on this server.' }],
        warnings: 0,
        log: '',
        pdf: false,
      });
    }
    fs.mkdirSync(src, { recursive: true });
    fs.mkdirSync(path.join(build, 'var'), { recursive: true });
    syncSources(ref, src);
    const pdf = pdfPath(ref, main);
    fs.rmSync(pdf, { force: true });

    const inside = this.sandbox === 'bubblewrap';
    const work = inside ? '/work' : build;
    const latexmk = [
      'latexmk',
      '-norc',
      ENGINE_FLAG[engine],
      '-interaction=nonstopmode',
      '-file-line-error',
      '-synctex=1',
      '-e',
      `$${engine}='${engine} -no-shell-escape %O %S'`,
      main,
    ];
    const limits = ['prlimit', `--as=${this.memoryBytes}`, `--cpu=${Math.ceil(this.timeoutMs / 1000) + 5}`, '--'];
    const argv = inside ? [...limits, 'bwrap', ...sandboxArgs(build), ...latexmk] : [...limits, ...latexmk];
    const env = texEnv(inside ? '/tmp' : path.join(build, 'var'), `${work}/var`, engine);

    let output = '';
    const status = await new Promise<'done' | 'failed' | 'timeout' | 'spawn-error'>((resolve) => {
      let child;
      try {
        child = spawn(argv[0], argv.slice(1), { cwd: inside ? undefined : src, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch {
        resolve('spawn-error');
        return;
      }
      const take = (b: Buffer) => {
        output += b.toString('utf8');
        if (output.length > 4 * LOG_TAIL) output = output.slice(-2 * LOG_TAIL);
      };
      child.stdout.on('data', take);
      child.stderr.on('data', take);
      const timer = setTimeout(() => {
        try {
          process.kill(-child.pid!, 'SIGKILL');
        } catch {
          // already gone
        }
        resolve('timeout');
      }, this.timeoutMs);
      child.on('error', () => {
        clearTimeout(timer);
        resolve('spawn-error');
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve(code === 0 ? 'done' : 'failed');
      });
    });

    let texLog = '';
    try {
      texLog = fs.readFileSync(path.join(src, main.replace(/\.tex$/, '') + '.log'), 'latin1');
    } catch {
      texLog = '';
    }
    const parsed = parseLog(texLog || output);
    const hasPdf = fs.existsSync(pdf);
    const log = (output.slice(-LOG_TAIL / 4) + '\n' + texLog.slice(-LOG_TAIL)).trim();
    if (status === 'spawn-error') {
      return finish({ status: 'error', main, errors: [{ file: null, line: null, message: 'latexmk could not be started on this server.' }], warnings: 0, log, pdf: false });
    }
    if (status === 'timeout') {
      return finish({
        status: 'timeout',
        main,
        errors: [{ file: null, line: null, message: `The compile took longer than ${Math.round(this.timeoutMs / 1000)} seconds and was stopped.` }, ...parsed.errors],
        warnings: parsed.warnings,
        log,
        pdf: hasPdf,
      });
    }
    return finish({
      status: status === 'done' && parsed.errors.length === 0 ? 'success' : 'failure',
      main,
      errors: parsed.errors.length || status === 'done' ? parsed.errors : [{ file: null, line: null, message: 'The compile failed; see the log.' }],
      warnings: parsed.warnings,
      log,
      pdf: hasPdf,
    });
  }
}
