import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { Docs } from './docs';
import { ProjectRef, filesDir } from './projects';

// A project's git history: files/ committed into a bare repository beside it,
// <project>/repo.git, which is what `git clone` of the project serves. The
// shelf writes it; nobody pushes to it.
//
// A commit is made a while after changes stop (QUIET_MS), or after MAX_MS of
// steady editing, so the history reads as sessions of work rather than
// keystrokes; and at once before a clone is served, so a clone always has
// what the editors show. Each commit is attributed to the person who made most
// of its changes, and the message names everyone who took part. The working
// tree is files/ itself and the index lives inside repo.git, so nothing git
// keeps ever appears among the project's files.

const QUIET_MS = 60_000;
const MAX_MS = 10 * 60_000;

export function repoDir(ref: ProjectRef): string {
  return path.join(ref.dir, 'repo.git');
}

function git(ref: ProjectRef, args: string[], extraEnv: NodeJS.ProcessEnv = {}): Promise<string> {
  const gitDir = repoDir(ref);
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      {
        env: {
          PATH: process.env.PATH,
          HOME: gitDir,
          GIT_DIR: gitDir,
          GIT_WORK_TREE: filesDir(ref.dir),
          GIT_INDEX_FILE: path.join(gitDir, 'ohagi-index'),
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          ...extraEnv,
        },
        maxBuffer: 16 * 1024 * 1024,
      },
      (err, stdout, stderr) => (err ? reject(new Error(`git ${args[0]}: ${stderr || err.message}`)) : resolve(stdout))
    );
  });
}

/** A new bare repository, made with nothing of the project's environment set. */
function initRepo(dir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['init', '--bare', '--quiet', '--initial-branch=main', dir],
      { env: { PATH: process.env.PATH, HOME: path.dirname(dir), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } },
      (err, _out, stderr) => (err ? reject(new Error(`git init: ${stderr || err.message}`)) : resolve())
    );
  });
}

interface Pending {
  ref: ProjectRef;
  /** Changes per person since the last commit. */
  editors: Map<string, number>;
  first: number;
  timer: NodeJS.Timeout | null;
}

export class History {
  private readonly pending = new Map<string, Pending>();
  /** One commit per project at a time. */
  private readonly running = new Map<string, Promise<string | null>>();

  constructor(
    private readonly docs: Docs,
    private readonly host: () => string = () => 'localhost'
  ) {}

  /** Someone changed the project; a commit follows once things go quiet. */
  touched(ref: ProjectRef, username: string, count = 1): void {
    let p = this.pending.get(ref.dir);
    if (!p) {
      p = { ref, editors: new Map(), first: Date.now(), timer: null };
      this.pending.set(ref.dir, p);
    }
    p.editors.set(username, (p.editors.get(username) ?? 0) + count);
    if (p.timer) clearTimeout(p.timer);
    const wait = Math.max(0, Math.min(QUIET_MS, p.first + MAX_MS - Date.now()));
    p.timer = setTimeout(() => void this.commitNow(ref).catch((e) => console.error(`history: ${e.message}`)), wait);
  }

  /**
   * Commit whatever the project holds now, if it differs from the last
   * commit. Returns the new commit, or null when there was nothing to commit.
   */
  async commitNow(ref: ProjectRef): Promise<string | null> {
    const before = this.running.get(ref.dir);
    if (before) await before.catch(() => null);
    const run = this.commit(ref).finally(() => {
      if (this.running.get(ref.dir) === run) this.running.delete(ref.dir);
    });
    this.running.set(ref.dir, run);
    return run;
  }

  private async commit(ref: ProjectRef): Promise<string | null> {
    const p = this.pending.get(ref.dir);
    if (p?.timer) clearTimeout(p.timer);
    this.pending.delete(ref.dir);
    this.docs.flushProject(ref.dir);
    await this.docs.settle(ref.dir);
    if (!fs.existsSync(repoDir(ref))) await initRepo(repoDir(ref));
    await git(ref, ['add', '--all', '--', '.']);
    const status = await git(ref, ['status', '--porcelain']);
    if (!status.trim()) return null;
    const editors = [...(p?.editors ?? new Map<string, number>()).entries()].sort((a, b) => b[1] - a[1]);
    const author = editors[0]?.[0] ?? 'ohagi';
    const names = editors.map(([n]) => n);
    const message = names.length ? `Edits by ${names.join(', ')}` : 'Files changed on disk';
    const host = this.host();
    await git(ref, ['commit', '--quiet', '--no-verify', '-m', message], {
      GIT_AUTHOR_NAME: author,
      GIT_AUTHOR_EMAIL: `${author}@noreply.${host}`,
      GIT_COMMITTER_NAME: 'ohagi',
      GIT_COMMITTER_EMAIL: `ohagi@noreply.${host}`,
    });
    return (await git(ref, ['rev-parse', 'HEAD'])).trim();
  }

  /** A project going away: nothing of it is committed after this. */
  forget(dir: string): void {
    const p = this.pending.get(dir);
    if (p?.timer) clearTimeout(p.timer);
    this.pending.delete(dir);
  }

  /** Commit every project with changes waiting, as the server stops. */
  async commitAll(): Promise<void> {
    for (const p of [...this.pending.values()]) {
      try {
        await this.commitNow(p.ref);
      } catch (e) {
        console.error(`history: ${(e as Error).message}`);
      }
    }
  }
}
