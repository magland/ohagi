import * as fs from 'fs';
import * as path from 'path';
import { LiveDoc } from './livedoc';
import { ProjectRef, cleanPath, collabDir, filesDir, isEditableText } from './projects';

// The files being edited, held in memory while anyone has them open (see
// src/livedoc.ts), keyed by project directory and path.

export class DocNotFound extends Error {}

export class Docs {
  private readonly open = new Map<string, LiveDoc>();

  /** The live document for a text file of the project, loading it on first use. */
  get(ref: ProjectRef, rel: string): LiveDoc {
    const clean = cleanPath(rel);
    if (!clean) throw new DocNotFound('bad path');
    const key = `${ref.dir}\0${clean}`;
    const have = this.open.get(key);
    if (have) return have;
    const file = path.join(filesDir(ref.dir), clean);
    let size: number;
    try {
      const st = fs.statSync(file);
      if (!st.isFile()) throw new Error();
      size = st.size;
    } catch {
      throw new DocNotFound('no such file');
    }
    if (!isEditableText(file, size)) throw new DocNotFound('not a text file');
    const doc = new LiveDoc(file, path.join(collabDir(ref.dir), `${clean}.json`), path.join(collabDir(ref.dir), `${clean}.log`));
    this.open.set(key, doc);
    return doc;
  }

  /** Write every open document that has unwritten changes. */
  flushAll(): void {
    for (const doc of this.open.values()) doc.flush();
  }

  /** Forget every open document of a project that is going away, without writing them. */
  dropProject(dir: string): void {
    for (const [key, doc] of this.open) {
      if (key.startsWith(`${dir}\0`)) {
        doc.close();
        this.open.delete(key);
      }
    }
  }

  /** Drop documents nobody has open, once they are written. */
  unloadIdle(): void {
    for (const [key, doc] of this.open) {
      if (doc.subscribers.size === 0) {
        doc.flush();
        this.open.delete(key);
      }
    }
  }
}
