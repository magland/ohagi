import * as fs from 'fs';
import * as path from 'path';
import { LiveDoc } from './livedoc';

// A shelf is one directory holding collections of projects, laid out the way
// a mochi vault holds collections of repositories:
//
//   <shelf>/
//     collections/
//       alice/
//         projects/
//           thesis/
//             files/        the project's files, as they would be cloned
//             collab/       per text file: <file>.json and <file>.log
//
// As in mochi, the two levels that hold only names somebody chose
// (collections/ and projects/) hold nothing else, so a file the shelf or a
// collection later gains takes no name away. files/ holds nothing but the
// project, so it can become a git working tree without the editing state
// showing up in it.

// Names the interface owns as top-level path segments, since a collection is
// reached at /<collection> and a project at /<collection>/<project>. The same
// list and rule as mochi's (src/scan.ts there), copied until ohagi imports
// mochiforge's modules; the leading dot mochi allows for a repository alone
// is not allowed here.
const RESERVED_NAMES = new Set(['about', 'api', 'assets', 'favicon.ico', 'favicon.svg', 'login', 'logout', 'new', 'import', 'admin', 'settings', 'topics']);

export function isValidName(name: string): boolean {
  if (RESERVED_NAMES.has(name)) return false;
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) && !name.includes('..') && name.length <= 100;
}

/** Files larger than this are not opened for editing. */
const MAX_EDIT_BYTES = 4 * 1024 * 1024;

export class NotFound extends Error {}

export class Shelf {
  private readonly docs = new Map<string, LiveDoc>();

  constructor(readonly root: string) {
    fs.mkdirSync(path.join(root, 'collections'), { recursive: true });
  }

  private static subdirs(dir: string): string[] {
    try {
      return fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && isValidName(d.name))
        .map((d) => d.name)
        .sort();
    } catch {
      return [];
    }
  }

  collections(): string[] {
    return Shelf.subdirs(path.join(this.root, 'collections'));
  }

  collectionDir(collection: string): string {
    const dir = path.join(this.root, 'collections', collection);
    if (!isValidName(collection) || !fs.existsSync(dir)) throw new NotFound('no such collection');
    return dir;
  }

  projects(collection: string): string[] {
    return Shelf.subdirs(path.join(this.collectionDir(collection), 'projects')).filter((p) =>
      fs.existsSync(path.join(this.root, 'collections', collection, 'projects', p, 'files')),
    );
  }

  projectDir(collection: string, project: string): string {
    if (!isValidName(project)) throw new NotFound('no such project');
    const dir = path.join(this.collectionDir(collection), 'projects', project);
    if (!fs.existsSync(path.join(dir, 'files'))) throw new NotFound('no such project');
    return dir;
  }

  /**
   * A project-relative path, checked: no absolute paths, nothing that climbs
   * out, no dot-segments at all (so neither .git nor a hidden file is ever
   * served), forward slashes only.
   */
  static cleanPath(rel: string): string {
    if (typeof rel !== 'string' || !rel || rel.length > 500) throw new NotFound('bad path');
    const parts = rel.split('/');
    if (parts.some((p) => !p || p.startsWith('.') || p.includes('\\') || p.includes('\0'))) throw new NotFound('bad path');
    return parts.join('/');
  }

  /** The project's files, relative, sorted, with whether each can be edited as text. */
  files(collection: string, project: string): { path: string; text: boolean; size: number }[] {
    const root = path.join(this.projectDir(collection, project), 'files');
    const out: { path: string; text: boolean; size: number }[] = [];
    const walk = (dir: string, prefix: string) => {
      for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
        if (d.name.startsWith('.')) continue;
        const rel = prefix ? `${prefix}/${d.name}` : d.name;
        if (d.isDirectory()) walk(path.join(dir, d.name), rel);
        else if (d.isFile()) {
          const size = fs.statSync(path.join(dir, d.name)).size;
          out.push({ path: rel, text: isText(path.join(dir, d.name), size), size });
        }
      }
    };
    walk(root, '');
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  /** The open document for a text file, loading it on first use. */
  doc(collection: string, project: string, rel: string): LiveDoc {
    const clean = Shelf.cleanPath(rel);
    const dir = this.projectDir(collection, project);
    const key = `${collection}/${project}/${clean}`;
    const open = this.docs.get(key);
    if (open) return open;
    const file = path.join(dir, 'files', clean);
    let size: number;
    try {
      const st = fs.statSync(file);
      if (!st.isFile()) throw new Error();
      size = st.size;
    } catch {
      throw new NotFound('no such file');
    }
    if (!isText(file, size)) throw new NotFound('not a text file');
    const doc = new LiveDoc(file, path.join(dir, 'collab', `${clean}.json`), path.join(dir, 'collab', `${clean}.log`));
    this.docs.set(key, doc);
    return doc;
  }

  /** Write every open document that has unwritten changes. */
  flushAll(): void {
    for (const doc of this.docs.values()) doc.flush();
  }

  /** Drop documents nobody has open, once they are written. */
  unloadIdle(): void {
    for (const [key, doc] of this.docs) {
      if (doc.subscribers.size === 0) {
        doc.flush();
        this.docs.delete(key);
      }
    }
  }
}

function isText(file: string, size: number): boolean {
  if (size > MAX_EDIT_BYTES) return false;
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(Math.min(size, 8192));
    fs.readSync(fd, buf, 0, buf.length, 0);
    if (buf.includes(0)) return false;
    // Reject what does not decode as UTF-8 (allowing a character cut off at the end of the sample).
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(size > buf.length ? buf.subarray(0, buf.length - 4) : buf);
    } catch {
      return false;
    }
    return true;
  } finally {
    fs.closeSync(fd);
  }
}
