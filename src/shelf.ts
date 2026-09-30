import * as fs from 'fs';
import * as path from 'path';
import { LiveDoc } from './livedoc';

// A shelf is one directory holding projects:
//
//   <shelf>/
//     projects/
//       thesis/
//         files/            the project's files, as they would be cloned
//         collab/           per text file: <file>.json and <file>.log
//
// files/ holds nothing but the project, so it can become a git working tree
// without the editing state showing up in it.

const PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
/** Files larger than this are not opened for editing. */
const MAX_EDIT_BYTES = 4 * 1024 * 1024;

export class NotFound extends Error {}

export class Shelf {
  private readonly docs = new Map<string, LiveDoc>();

  constructor(readonly root: string) {
    fs.mkdirSync(path.join(root, 'projects'), { recursive: true });
  }

  projects(): string[] {
    return fs
      .readdirSync(path.join(this.root, 'projects'), { withFileTypes: true })
      .filter((d) => d.isDirectory() && PROJECT_NAME.test(d.name))
      .map((d) => d.name)
      .sort();
  }

  projectDir(project: string): string {
    if (!PROJECT_NAME.test(project)) throw new NotFound('no such project');
    const dir = path.join(this.root, 'projects', project);
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
  files(project: string): { path: string; text: boolean; size: number }[] {
    const root = path.join(this.projectDir(project), 'files');
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
  doc(project: string, rel: string): LiveDoc {
    const clean = Shelf.cleanPath(rel);
    const dir = this.projectDir(project);
    const key = `${project}/${clean}`;
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
