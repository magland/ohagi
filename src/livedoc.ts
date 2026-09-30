import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { ChangeSet, Text } from '@codemirror/state';

// A file being edited, held in memory while anyone has it open. The server is
// the single authority over its text, in the way @codemirror/collab expects:
// each accepted change moves the file's version up by one, and a browser
// pushes its changes together with the version they were made against. A
// push against any version but the current one is refused as stale; the page
// waits for the changes it is missing, rebases its own over them, and pushes
// again. Only the page ever rebases. The server could rebase a stale push
// itself (collab offers rebaseUpdates for this), but then both sides
// transform the same change independently, the page over each batch of
// changes as it arrives and the server over all of them composed, and the
// two do not always agree: an insertion inside a range that was deleted and
// then refilled lands differently. The tests found exactly that. Refusing
// costs a round trip under contention, which at the scale of a few people in
// one file is nothing.
//
// Every accepted change is sent to every open page, the pusher's included,
// since that echo is how a page learns its changes were confirmed. The same
// rule makes a resent push harmless: if the first copy was taken, the version
// has moved past the one it names.
//
// On disk a file stays a plain file. Beside it, under the project's collab/
// directory, sit two things: <file>.log, one line per accepted change, which
// is appended before the change is acknowledged, and <file>.json, the version
// and hash of the text as last written. The text itself is written a moment
// after typing stops. After a crash the log holds whatever the file missed,
// and loading replays it. The log also keeps recent history, so that a page
// left open across a restart can catch up from its own version rather than
// start over.
//
// An *epoch* names one unbroken history. If the file on disk is not the text
// the metadata describes (someone edited it with another tool, or the
// metadata is missing), the history cannot be continued, and a new epoch
// starts at version 0; a page from the old epoch is sent the whole text.

/** How many accepted changes are kept for pages catching up. */
const KEEP = 1000;
/** The largest text accepted, in characters. */
const MAX_LENGTH = 4_000_000;
const FLUSH_DELAY_MS = 800;
const FLUSH_MAX_DELAY_MS = 5000;

export interface UpdateJSON {
  clientID: string;
  changes: unknown;
}

interface Update {
  clientID: string;
  changes: ChangeSet;
}

interface Meta {
  epoch: string;
  version: number;
  sha256: string;
}

export interface Peer {
  clientID: string;
  name: string;
  anchor: number;
  head: number;
}

export type DocEvent =
  | { type: 'updates'; from: number; updates: UpdateJSON[] }
  | { type: 'reset'; epoch: string; version: number; doc: string }
  | { type: 'presence'; peer: Peer }
  | { type: 'gone'; clientID: string }
  /** The project was compiled; every open page of it is told, so its PDF pane can refresh. */
  | { type: 'compiled'; result: CompiledSummary }
  /** The file went away under the page: renamed (to the path given) or deleted. */
  | { type: 'closed'; reason: 'moved' | 'deleted'; to?: string };

/** What a page is told of a compile: the result without its log, which is fetched when wanted. */
export interface CompiledSummary {
  status: string;
  main: string;
  errors: { file: string | null; line: number | null; message: string }[];
  warnings: number;
  pdf: boolean;
  durationMs: number;
  finished: string;
}

export interface Subscriber {
  clientID: string;
  send(event: DocEvent): void;
  /** End the stream, when the document goes away under it. */
  end?(): void;
}

/** The page's history is not this one; it should reconnect and will be sent the whole text. */
export class PushRefused extends Error {}

export type PushResult = { accepted: true; version: number } | { accepted: false; version: number };

function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function newEpoch(): string {
  return crypto.randomBytes(6).toString('hex');
}

function writeAtomic(file: string, data: string): void {
  // A dot-name, so a listing of the project never shows it.
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.tmp-${process.pid}`);
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

export class LiveDoc {
  epoch = '';
  text: Text = Text.empty;
  /** The version the first kept update applies to. */
  base = 0;
  updates: Update[] = [];
  private flushedVersion = 0;
  private logLines = 0;
  private flushTimer: NodeJS.Timeout | null = null;
  private firstUnflushedAt = 0;
  readonly subscribers = new Set<Subscriber>();
  readonly peers = new Map<string, Peer>();

  constructor(
    readonly file: string,
    private readonly metaFile: string,
    private readonly logFile: string,
  ) {
    this.load();
  }

  get version(): number {
    return this.base + this.updates.length;
  }

  private load(): void {
    const raw = fs.readFileSync(this.file, 'utf8');
    let meta: Meta | null = null;
    try {
      meta = JSON.parse(fs.readFileSync(this.metaFile, 'utf8'));
    } catch {
      meta = null;
    }
    this.text = Text.of(raw.split(/\r\n?|\n/));
    if (meta && meta.sha256 === sha256(raw)) {
      this.epoch = meta.epoch;
      const kept: Update[] = [];
      let version = meta.version;
      let lines: string[] = [];
      try {
        lines = fs.readFileSync(this.logFile, 'utf8').split('\n').filter((l) => l);
      } catch {
        lines = [];
      }
      // The log's lines carry consecutive versions. Those up to the
      // metadata's version are history; those past it are changes the file
      // never received, replayed now.
      let firstKept: number | null = null;
      for (const line of lines) {
        let entry: { v: number; c: string; ch: unknown };
        let update: Update;
        try {
          entry = JSON.parse(line);
          update = { clientID: entry.c, changes: ChangeSet.fromJSON(entry.ch) };
        } catch {
          break; // a torn last line from a crash mid-append
        }
        if (entry.v <= meta.version) {
          firstKept ??= entry.v - 1;
          kept.push(update);
        } else if (entry.v === version + 1 && update.changes.length === this.text.length) {
          this.text = update.changes.apply(this.text);
          firstKept ??= version;
          kept.push(update);
          version++;
        } else {
          break;
        }
      }
      if (firstKept === null || firstKept + kept.length !== version) {
        kept.length = 0;
        firstKept = version;
      }
      this.base = firstKept;
      this.updates = kept;
      this.logLines = lines.length;
      this.flushedVersion = meta.version;
      if (version !== meta.version) this.flush();
      this.trim();
    } else {
      this.epoch = newEpoch();
      this.base = 0;
      this.updates = [];
      fs.mkdirSync(path.dirname(this.metaFile), { recursive: true });
      writeAtomic(this.logFile, '');
      this.logLines = 0;
      this.writeMeta(raw);
    }
  }

  private writeMeta(raw: string): void {
    const meta: Meta = { epoch: this.epoch, version: this.version, sha256: sha256(raw) };
    writeAtomic(this.metaFile, JSON.stringify(meta) + '\n');
    this.flushedVersion = this.version;
  }

  /**
   * Accept changes made against the current version. A push against an
   * earlier one is stale and taken as nothing; either way the answer carries
   * the version the page should wait for before pushing again. Throws
   * PushRefused when the page's history is not this one, and any other error
   * for a malformed push.
   */
  push(epoch: string, version: number, updatesJSON: UpdateJSON[]): PushResult {
    if (epoch !== this.epoch || version < this.base || version > this.version) throw new PushRefused();
    if (version !== this.version) return { accepted: false, version: this.version };
    const updates: Update[] = updatesJSON.map((u) => {
      if (typeof u.clientID !== 'string' || !u.clientID) throw new Error('clientID required');
      return { clientID: u.clientID, changes: ChangeSet.fromJSON(u.changes) };
    });
    if (!updates.length) return { accepted: true, version: this.version };
    // Check the whole push before taking any of it.
    let text = this.text;
    for (const u of updates) {
      if (u.changes.length !== text.length) throw new Error('change does not fit the document');
      text = u.changes.apply(text);
      if (text.length > MAX_LENGTH) throw new Error('document too large');
    }
    const from = this.version;
    const lines = updates.map((u, i) => JSON.stringify({ v: from + i + 1, c: u.clientID, ch: u.changes.toJSON() })).join('\n') + '\n';
    fs.appendFileSync(this.logFile, lines);
    this.logLines += updates.length;
    this.text = text;
    this.updates.push(...updates);
    for (const peer of this.peers.values()) {
      for (const u of updates) {
        peer.anchor = u.changes.mapPos(peer.anchor, 1);
        peer.head = u.changes.mapPos(peer.head, 1);
      }
    }
    this.trim();
    const event: DocEvent = {
      type: 'updates',
      from,
      updates: updates.map((u) => ({ clientID: u.clientID, changes: u.changes.toJSON() })),
    };
    for (const s of this.subscribers) s.send(event);
    this.scheduleFlush();
    return { accepted: true, version: this.version };
  }

  private trim(): void {
    if (this.updates.length > KEEP) {
      const drop = this.updates.length - KEEP;
      this.updates = this.updates.slice(drop);
      this.base += drop;
    }
  }

  /**
   * Record where a page's selection is. The positions are in the text at
   * `version`, and are carried forward to the current version before being
   * passed on, so every page receives them in the text it holds.
   */
  presence(epoch: string, version: number, peer: Peer): void {
    if (epoch !== this.epoch || version < this.base || version > this.version) return;
    let { anchor, head } = peer;
    for (const u of this.updates.slice(version - this.base)) {
      anchor = u.changes.mapPos(anchor, 1);
      head = u.changes.mapPos(head, 1);
    }
    const len = this.text.length;
    const p: Peer = {
      clientID: peer.clientID,
      name: peer.name,
      anchor: Math.max(0, Math.min(len, anchor)),
      head: Math.max(0, Math.min(len, head)),
    };
    this.peers.set(p.clientID, p);
    for (const s of this.subscribers) if (s.clientID !== p.clientID) s.send({ type: 'presence', peer: p });
  }

  /**
   * Open a page's stream: bring it up to date from the version it holds, or
   * send the whole text when that version is not in this history.
   */
  subscribe(s: Subscriber, epoch: string, version: number): () => void {
    if (epoch === this.epoch && version >= this.base && version <= this.version) {
      if (version < this.version) {
        s.send({
          type: 'updates',
          from: version,
          updates: this.updates.slice(version - this.base).map((u) => ({ clientID: u.clientID, changes: u.changes.toJSON() })),
        });
      }
    } else {
      s.send({ type: 'reset', epoch: this.epoch, version: this.version, doc: this.text.toString() });
    }
    for (const p of this.peers.values()) if (p.clientID !== s.clientID) s.send({ type: 'presence', peer: p });
    this.subscribers.add(s);
    return () => {
      this.subscribers.delete(s);
      if (![...this.subscribers].some((o) => o.clientID === s.clientID) && this.peers.delete(s.clientID)) {
        for (const o of this.subscribers) o.send({ type: 'gone', clientID: s.clientID });
      }
    };
  }

  private scheduleFlush(): void {
    const now = Date.now();
    if (!this.flushTimer) this.firstUnflushedAt = now;
    else clearTimeout(this.flushTimer);
    const wait = Math.max(0, Math.min(FLUSH_DELAY_MS, this.firstUnflushedAt + FLUSH_MAX_DELAY_MS - now));
    this.flushTimer = setTimeout(() => this.flush(), wait);
  }

  /** Write the text and its metadata, and shorten the log when it has grown long. */
  flush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (this.flushedVersion === this.version) return;
    const raw = this.text.toString();
    writeAtomic(this.file, raw);
    this.writeMeta(raw);
    if (this.logLines > 2 * KEEP) {
      const lines = this.updates.map((u, i) => JSON.stringify({ v: this.base + i + 1, c: u.clientID, ch: u.changes.toJSON() }));
      writeAtomic(this.logFile, lines.map((l) => l + '\n').join(''));
      this.logLines = lines.length;
    }
  }

  /** Tell every open page something about the project, not the file. */
  announce(event: DocEvent): void {
    for (const s of this.subscribers) s.send(event);
  }

  /**
   * Stop: no further writes, and every open stream is told why, when there is
   * something to tell, and ended. The caller writes first if the text should
   * survive (a rename does; a deletion does not).
   */
  close(event?: DocEvent): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.flushedVersion = this.version;
    for (const s of [...this.subscribers]) {
      if (event) s.send(event);
      s.end?.();
    }
    this.subscribers.clear();
    this.peers.clear();
  }

  /**
   * The file on disk was replaced (an upload over it): take its text as a new
   * history, since the old one cannot be continued into it, and send every
   * open page the whole text, as a page from an old epoch is sent it.
   */
  reloadFromDisk(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    const raw = fs.readFileSync(this.file, 'utf8');
    this.text = Text.of(raw.split(/\r\n?|\n/));
    this.epoch = newEpoch();
    this.base = 0;
    this.updates = [];
    writeAtomic(this.logFile, '');
    this.logLines = 0;
    this.writeMeta(raw);
    this.peers.clear();
    const event: DocEvent = { type: 'reset', epoch: this.epoch, version: this.version, doc: this.text.toString() };
    for (const s of this.subscribers) s.send(event);
  }

  get dirty(): boolean {
    return this.flushedVersion !== this.version;
  }
}
