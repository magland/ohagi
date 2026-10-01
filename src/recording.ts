import * as fs from 'fs';
import * as path from 'path';
import { ChangeSet, Text } from '@codemirror/state';
import { Recorder, type Cause, type Change } from '../../arewehuman/src/editor/recorder';
import { MemoryClips, type ClipRegistry } from '../../arewehuman/src/editor/clips';
import { bodyLines, finalLine, LOG_SUFFIX, parseLog, serializeLog } from '../../arewehuman/src/prov/log';
import { diffText } from '../../arewehuman/src/prov/diff';
import { ProjectRef, filesDir } from './projects';

// Recording how a project is written, with arewehuman
// (https://github.com/magland/arewehuman). A project opts in by having a
// .arewehuman directory among its files, with config.json naming the files to
// record:
//
//   files/.arewehuman/config.json             { "autoRecord": ["*.tex", "*.md"] }
//   files/.arewehuman/<path>/ohagi.awh.jsonl  the recording of files/<path>
//
// Being under files/, the recordings are committed with the project and come
// with a clone; being a dot-directory, they are not among the files the
// interface lists, edits, or compiles.
//
// In arewehuman's terms this shelf is one workspace, "ohagi", and each file has
// one recording that everyone editing it shares. The page says how each of its
// edits came about (typed, pasted, undone, moved; see client/awh.ts), as
// arewehuman's own editors do, and the server adds who made it, from the
// session, and when, by its own clock: an author event names the person
// whenever that changes. Text that was cut or copied in one file of the
// project and pasted into another is recorded as coming from that file's
// recording.

export const STORE = '.arewehuman';
export const WORKSPACE = 'ohagi';
export const CONFIG = 'config.json';
export const DEFAULT_PATTERNS = ['*.tex', '*.md'];

export const storeDir = (ref: ProjectRef) => path.join(filesDir(ref.dir), STORE);
export const recordingDir = (ref: ProjectRef, rel: string) => path.join(storeDir(ref), rel);
export const recordingFile = (ref: ProjectRef, rel: string) => path.join(recordingDir(ref, rel), WORKSPACE + LOG_SUFFIX);

export function isSetUp(ref: ProjectRef): boolean {
  try {
    return fs.statSync(storeDir(ref)).isDirectory();
  } catch {
    return false;
  }
}

/** The project's autoRecord patterns, or null when it is not set up for recording. */
export function patterns(ref: ProjectRef): string[] | null {
  if (!isSetUp(ref)) return null;
  try {
    const v = JSON.parse(fs.readFileSync(path.join(storeDir(ref), CONFIG), 'utf8'))?.autoRecord;
    return Array.isArray(v) ? v.filter((p): p is string => typeof p === 'string' && p.length > 0) : [];
  } catch {
    return [];
  }
}

/** Set the project up for recording (or change which files are recorded). */
export function setPatterns(ref: ProjectRef, list: string[]): void {
  fs.mkdirSync(storeDir(ref), { recursive: true });
  let config: Record<string, unknown> = {};
  try {
    const v = JSON.parse(fs.readFileSync(path.join(storeDir(ref), CONFIG), 'utf8'));
    if (v && typeof v === 'object' && !Array.isArray(v)) config = v;
  } catch {
    // a new or unreadable file is replaced
  }
  config.autoRecord = list;
  fs.writeFileSync(path.join(storeDir(ref), CONFIG), JSON.stringify(config, null, 2) + '\n');
}

// A glob pattern as arewehuman's VS Code extension reads it: relative to the
// project root, with * and ? within a name and ** across directories; a
// pattern without a slash matches the file name in any directory.
function globRegex(p: string): RegExp {
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*' && p[i + 1] === '*') {
      i++;
      if (p[i + 1] === '/') {
        i++;
        re += '(?:.*/)?';
      } else re += '.*';
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

export function matchesPatterns(list: string[], rel: string): boolean {
  return list.some((p) => globRegex(p.includes('/') ? p : `**/${p}`).test(rel));
}

/** Whether a file is recorded: the project is set up, and the file has a recording or matches a pattern. */
export function isRecorded(ref: ProjectRef, rel: string): boolean {
  const list = patterns(ref);
  return list !== null && (fs.existsSync(recordingFile(ref, rel)) || matchesPatterns(list, rel));
}

/** How the page says an edit came about (see client/awh.ts). */
export interface EditMeta {
  cause: Cause;
  /** For a paste: the nonce on the clipboard, null if none. */
  nonce?: string | null;
  /** For a cut: the nonce the page put on the clipboard. */
  clip?: string;
  /** When the edit was made, by the page's clock (ms). */
  t: number;
}

const CAUSES: Cause[] = ['typed', 'paste', 'drop', 'copyline', 'undo', 'move', 'other'];
const okNonce = (x: unknown): x is string => typeof x === 'string' && x.length > 0 && x.length <= 100;

/** The page's description of an edit, or undefined when it gave none or a malformed one. */
export function readMeta(x: unknown): EditMeta | undefined {
  if (!x || typeof x !== 'object') return undefined;
  const m = x as Record<string, unknown>;
  if (!CAUSES.includes(m.cause as Cause) || typeof m.t !== 'number' || !Number.isFinite(m.t)) return undefined;
  return {
    cause: m.cause as Cause,
    t: m.t,
    ...(okNonce(m.nonce) ? { nonce: m.nonce } : m.nonce === null ? { nonce: null } : {}),
    ...(okNonce(m.clip) ? { clip: m.clip } : {}),
  };
}

/** How far a page's clock may run behind the server's for its edits' times to be used. */
const MAX_LAG_MS = 10 * 60_000;

// Recent copies made in each project's files: nonces and character ids, never
// text, kept in memory (see arewehuman's src/editor/clips.ts).
const registries = new Map<string, MemoryClips>();
function registry(ref: ProjectRef): ClipRegistry {
  let r = registries.get(ref.dir);
  if (!r) {
    r = new MemoryClips();
    registries.set(ref.dir, r);
  }
  return r;
}

interface OnDisk {
  events: number;
  checkpoints: number;
  head: number; // bytes before the final line
  final: string;
}

/** The recording of one open file. Its recorder holds the same text as the file's LiveDoc. */
export class DocRecording {
  private disk: OnDisk | null = null;
  private writing: Promise<void> = Promise.resolve();
  /** Whether opening found the file changed since its recording was written. */
  changedOnOpen = false;
  private written = -1; // events in the recording file

  private constructor(
    readonly file: string,
    private readonly title: string,
    readonly rec: Recorder,
  ) {}

  /** Start or resume the recording of a file whose text is `text`. */
  static open(ref: ProjectRef, rel: string, text: string): DocRecording {
    const file = recordingFile(ref, rel);
    const title = path.basename(rel);
    let rec: Recorder | null = null;
    let disk: OnDisk | null = null;
    let recorded = '';
    let raw: string | null = null;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      raw = null;
    }
    if (raw !== null) {
      try {
        const p = parseLog(raw);
        rec = Recorder.resume(p.doc, Date.now());
        recorded = p.doc.text;
        if (raw.endsWith(p.final))
          disk = { ...p.mark, head: Buffer.byteLength(raw) - Buffer.byteLength(p.final), final: p.final };
      } catch (e) {
        // Keep a recording that cannot be continued, under a name the viewer
        // does not read, and start a new one.
        fs.renameSync(file, `${file}.invalid-${Date.now()}`);
        console.error(`recording: ${file} could not be continued (${(e as Error).message}); kept aside`);
      }
    }
    if (!rec) {
      rec = Recorder.fresh(Date.now(), text);
      recorded = text;
    }
    rec.clips = registry(ref);
    rec.docKey = rel;
    rec.project = `ohagi|${ref.dir}`;
    const r = new DocRecording(file, title, rec);
    r.disk = disk;
    r.written = disk ? disk.events : -1;
    // The file changed while it was not being recorded (an upload, an edit on
    // disk): the difference is recorded as "other", by nobody known.
    if (recorded !== text) {
      r.outside(recorded, text, '');
      r.changedOnOpen = true;
    }
    return r;
  }

  /** A change taken from a page: recorded as the page describes it, by `author`, at a time by the server's clock. */
  accept(before: Text, changes: ChangeSet, meta: EditMeta | undefined, author: string, receivedAt: number, sentAt: number | undefined): void {
    const list: Change[] = [];
    changes.iterChanges((fromA, toA, fromB, _toB, inserted) =>
      list.push({ fromA, toA, fromB, text: inserted.toString(), removed: before.sliceString(fromA, toA) }),
    );
    if (!list.length) return;
    const lag = meta && typeof sentAt === 'number' ? sentAt - meta.t : 0;
    const t = receivedAt - (lag > 0 && lag < MAX_LAG_MS ? lag : 0) - this.rec.t0;
    this.rec.noteAuthor(t, author);
    if (meta?.clip) {
      // A cut: its characters, about to be deleted, can be pasted back as a move.
      const ranges = list.filter((c) => c.toA > c.fromA).map((c) => ({ from: c.fromA, to: c.toA }));
      const parts = ranges.map((r) => before.sliceString(r.from, r.to));
      if (ranges.length) this.rec.captureRanges('cut', ranges, (a, b) => before.sliceString(a, b), parts, parts.join('\n'), this.rec.live, meta.clip);
    }
    this.rec.applyChanges(list, t, meta?.cause ?? 'other', meta?.cause === 'paste' ? meta.nonce : undefined);
  }

  /** A copy made in a page: its characters, in the text as it is now, under the nonce the page put on the clipboard. */
  copied(text: Text, ranges: { from: number; to: number }[], nonce: string): void {
    const parts = ranges.map((r) => text.sliceString(r.from, r.to));
    this.rec.captureRanges('copy', ranges, (a, b) => text.sliceString(a, b), parts, parts.join('\n'), this.rec.live, nonce);
  }

  /** The text changed other than through the editor: recorded as "other", by `author` ("" when unknown). */
  outside(before: string, after: string, author: string): void {
    const cs = diffText(before, after);
    if (!cs.length) return;
    const t = Date.now() - this.rec.t0;
    this.rec.noteAuthor(t, author);
    this.rec.applyChanges(cs, t, 'other');
  }

  /**
   * Write the recording for the file's text as it now is, after any write
   * still under way. Usually this appends the new events in place of the old
   * final line; the whole file is written when it is not as last left.
   */
  save(text: string): Promise<void> {
    const next = this.writing.then(() => this.write(text)).catch((e) => console.error(`recording: ${this.file}: ${(e as Error).message}`));
    this.writing = next;
    return next;
  }

  /** Resolves once every write asked for so far is done. */
  settled(): Promise<void> {
    return this.writing;
  }

  private async write(text: string): Promise<void> {
    if (this.rec.events.length === this.written && this.disk) return;
    const doc = await this.rec.toDoc(text, this.title);
    const mark = { events: doc.events.length, checkpoints: doc.chain.checkpoints.length };
    const final = finalLine(doc);
    const d = this.disk;
    this.disk = null;
    if (d) {
      try {
        const fd = fs.openSync(this.file, 'r+');
        try {
          const old = Buffer.from(d.final);
          const cur = Buffer.alloc(old.length);
          if (fs.fstatSync(fd).size === d.head + old.length && fs.readSync(fd, cur, 0, old.length, d.head) === old.length && cur.equals(old)) {
            const add = Buffer.from(bodyLines(doc, d));
            const buf = Buffer.concat([add, Buffer.from(final)]);
            fs.writeSync(fd, buf, 0, buf.length, d.head);
            fs.ftruncateSync(fd, d.head + buf.length);
            this.disk = { ...mark, head: d.head + add.length, final };
          }
        } finally {
          fs.closeSync(fd);
        }
      } catch {
        // written whole below
      }
    }
    if (!this.disk) {
      const all = serializeLog(doc);
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = path.join(path.dirname(this.file), `.${path.basename(this.file)}.tmp-${process.pid}`);
      fs.writeFileSync(tmp, all);
      fs.renameSync(tmp, this.file);
      this.disk = { ...mark, head: Buffer.byteLength(all) - Buffer.byteLength(final), final };
    }
    this.written = mark.events;
  }
}

/** Move a file's recordings with it (the caller has written and closed it). */
export function moveRecordings(ref: ProjectRef, from: string, to: string): void {
  const a = recordingDir(ref, from);
  const b = recordingDir(ref, to);
  if (!fs.existsSync(a) || fs.existsSync(b)) return;
  fs.mkdirSync(path.dirname(b), { recursive: true });
  fs.renameSync(a, b);
}

/** Remove a file's recordings with it. */
export function removeRecordings(ref: ProjectRef, rel: string): void {
  fs.rmSync(recordingDir(ref, rel), { recursive: true, force: true });
}

/** Every recording in the project, with the file it belongs to. */
export function projectRecordings(ref: ProjectRef): { file: string; workspace: string; full: string }[] {
  const out: { file: string; workspace: string; full: string }[] = [];
  const walk = (dir: string, rel: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, rel ? `${rel}/${e.name}` : e.name);
      else if (e.isFile() && e.name.endsWith(LOG_SUFFIX) && rel) out.push({ file: rel, workspace: e.name.slice(0, -LOG_SUFFIX.length), full });
    }
  };
  walk(storeDir(ref), '');
  return out;
}

