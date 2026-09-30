import * as fs from 'fs';
import * as path from 'path';
import { BackupLayout } from '../../mochiforge/src/api/backup';
import { BackupProfile } from '../../mochiforge/src/cli/backup-cmd';
import { GITHUB_SECRET_FILE } from '../../mochiforge/src/githubauth';
import { collectionsDir } from '../../mochiforge/src/layout';

// Backing up a shelf, with mochi's protocol and mochi's client, as dango does
// a workspace. A shelf is a directory of ordinary files, so it needs no
// transport of its own: the manifest names the state files at the root and
// every file under collections/, and the client fetches what changed. The
// backup directory's current/ is a servable shelf.
//
// Each project's build/ is left out: it is what the last compile left, and
// the next compile makes it again from files/.

/** The state files at the shelf's root; nothing else there belongs to a shelf. */
const ROOT_FILES = ['shelf.json', 'config.json', '.secret', GITHUB_SECRET_FILE];

/** Which of those `--no-secrets` leaves out. config.json holds no credential. */
const SECRET_FILES = new Set(['shelf.json', '.secret', GITHUB_SECRET_FILE]);

/** A project's build/: a `build` beside a `files`, which is true of a project and nothing else. */
function isBuildDir(name: string, abs: string): boolean {
  return name === 'build' && fs.existsSync(path.join(path.dirname(abs), 'files'));
}

/** A project's collab/: the editing history beside its files. */
function isHistoryDir(name: string, abs: string): boolean {
  return name === 'collab' && fs.existsSync(path.join(path.dirname(abs), 'files'));
}

export function shelfLayout(root: string): BackupLayout {
  return {
    rootFiles: ROOT_FILES,
    secretFiles: SECRET_FILES,
    excludable: new Set(['history', 'secrets']),
    header: () => ({ lfs: 'volume' }),
    async walk(w, exclude) {
      const skipHistory = exclude.has('history');
      return w.tree(collectionsDir(root), (name, abs) => isBuildDir(name, abs) || (skipHistory && isHistoryDir(name, abs)));
    },
  };
}

export const OHAGI_BACKUP: BackupProfile = {
  exclusions: [
    { category: 'history', summary: "Leave out each project's editing history (collab/), keeping its files" },
    { category: 'secrets', summary: 'Leave out shelf.json, .secret, and .github-secret' },
  ],
  repos: false,
  description: `A shelf is a directory, so a backup of one is a directory too, and this makes it
over HTTP: it needs no shell on the server, no flyctl, and no rsync at the far
end, so it works the same against a Fly app, a VPS, a Docker deployment, and
127.0.0.1:3000.

  <dir>/current      a servable shelf. Restoring is: ohagi serve <dir>/current
  <dir>/snapshots    hardlinked copies, each one also a servable shelf
  <dir>/backup.json  which shelf, what is left out, and how each run went

Every file - each project's files and editing history, and the shelf's state
files - is compared by size and modification time and fetched only where it
differs, so a nightly run moves the day's edits and little else. What a compile
leaves in a project's build/ is not copied; the next compile makes it again.

The token needs to belong to a site admin, because the copy includes
shelf.json. The shelf URL, the exclusions, and the retention policy are
recorded in backup.json, so a cron entry is this command and a directory.

A run is a walk of a live tree: a file being edited is copied as last written,
which is at most a few seconds behind what its editors see.

Related: ohagi backup list, verify, prune.`,
  verifyDescription: `Asks the shelf for hashes of every file and reports anything missing, extra, or
different. Exits non-zero when there is something to report, so it can be run
from cron.`,
  pruneDescription: `Grandfather-father-son: the newest snapshot of each of the last N days, weeks,
and months is kept and the rest are removed, evaluated in UTC. The newest
snapshot is always kept.`,
};
