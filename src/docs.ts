import * as fs from 'fs';
import * as path from 'path';
import { DocEvent, LiveDoc } from './livedoc';
import { ProjectRef, cleanPath, collabDir, filesDir, isEditableText } from './projects';
import { DocRecording, isRecorded } from './recording';

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
    this.attachRecording(ref, clean, doc);
    return doc;
  }

  /** Start recording an open file, if its project records it and it is not recorded yet. */
  private attachRecording(ref: ProjectRef, rel: string, doc: LiveDoc): void {
    if (doc.recording || !isRecorded(ref, rel)) return;
    const text = doc.text.toString();
    doc.recording = DocRecording.open(ref, rel, text);
    // A difference found on opening (the file changed while not recorded) is written at once.
    if (doc.recording.changedOnOpen) void doc.recording.save(text);
  }

  /** The project's recording settings changed: start recording the open files they now cover. */
  refreshRecordings(ref: ProjectRef): void {
    for (const [key, doc] of this.open) if (key.startsWith(`${ref.dir}\0`)) this.attachRecording(ref, key.slice(ref.dir.length + 1), doc);
  }

  /** Resolves once every recording write asked for in the project is done. */
  async settle(dir: string): Promise<void> {
    for (const [key, doc] of this.open) if (key.startsWith(`${dir}\0`)) await doc.recording?.settled();
  }

  /** Write every open document that has unwritten changes. */
  flushAll(): void {
    for (const doc of this.open.values()) doc.flush();
  }

  /** The open document for a path, if it is open. */
  peek(ref: ProjectRef, rel: string): LiveDoc | undefined {
    const clean = cleanPath(rel);
    return clean ? this.open.get(`${ref.dir}\0${clean}`) : undefined;
  }

  /**
   * Close the open document for a path, if there is one, telling its pages
   * why. A rename writes it first, so its text and history move with the
   * file; a deletion does not.
   */
  async closeFile(ref: ProjectRef, rel: string, event: DocEvent & { type: 'closed' }): Promise<void> {
    const clean = cleanPath(rel);
    if (!clean) return;
    const key = `${ref.dir}\0${clean}`;
    const doc = this.open.get(key);
    if (!doc) return;
    this.open.delete(key);
    if (event.reason === 'moved') doc.flush();
    // Its recording is written before the file, and the recording, move or go.
    await doc.recording?.settled();
    doc.close(event);
  }

  /** Tell every open page of a project something about it, such as a new PDF. */
  announceProject(dir: string, event: DocEvent): void {
    for (const [key, doc] of this.open) if (key.startsWith(`${dir}\0`)) doc.announce(event);
  }

  /** Write every open document of a project, as before compiling it. */
  flushProject(dir: string): void {
    for (const [key, doc] of this.open) if (key.startsWith(`${dir}\0`)) doc.flush();
  }

  /** Forget every open document of a project that is going away, without writing them. */
  dropProject(dir: string): void {
    for (const [key, doc] of this.open) {
      if (key.startsWith(`${dir}\0`)) {
        doc.close({ type: 'closed', reason: 'deleted' });
        this.open.delete(key);
      }
    }
  }

  /**
   * A project is moving: write each open document, and send its pages to the
   * address the file will have, which `to` gives for a path.
   */
  async moveProject(dir: string, to: (rel: string) => string): Promise<void> {
    for (const [key, doc] of [...this.open]) {
      if (!key.startsWith(`${dir}\0`)) continue;
      const rel = key.slice(dir.length + 1);
      this.open.delete(key);
      doc.flush();
      await doc.recording?.settled();
      doc.close({ type: 'closed', reason: 'moved', to: to(rel) });
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
