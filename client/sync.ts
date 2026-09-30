import { ChangeSet, EditorState, Transaction } from '@codemirror/state';
import { getClientID, getSyncedVersion, receiveUpdates, sendableUpdates } from '@codemirror/collab';

// The page's half of the sync protocol, kept free of the DOM so that the
// tests drive exactly this code from Node.
//
// Changes go up by POST with the version they were made against. The server
// takes them only if that is its current version, and answers either way
// with the version the page should reach before pushing again: after its
// own changes, when they were taken, or after the ones it was missing, when
// the push was stale. The page learns its changes were taken when they come
// back down the event stream, which carries every accepted change in order,
// its own included, and receiveUpdates rebases whatever is still unsent over
// the others' changes on the way. Only the page rebases (see
// src/livedoc.ts for why). After a failure a push is sent again; if the
// first copy was in fact taken, the resend names an old version and is
// refused as stale.
//
// The stream is read with fetch rather than EventSource, so that a
// reconnect asks for changes from the version the page holds now, not the
// one it held when the stream first opened.

export interface Peer {
  clientID: string;
  name: string;
  anchor: number;
  head: number;
}

export interface CompiledSummary {
  status: 'success' | 'failure' | 'timeout' | 'error';
  main: string;
  errors: { file: string | null; line: number | null; message: string }[];
  warnings: number;
  pdf: boolean;
  durationMs: number;
  finished: string;
}

export type Status = 'connecting' | 'synced' | 'saving' | 'offline' | 'error' | 'deleted';

export interface SyncHost {
  state(): EditorState;
  dispatch(tr: Transaction): void;
  /** Replace the document; the history this page held is not the server's. */
  reset(doc: string, version: number, lostEdits: boolean): void;
  status?(s: Status): void;
  peer?(p: Peer): void;
  gone?(clientID: string): void;
  /** The project was compiled, by this page or another. */
  compiled?(result: CompiledSummary): void;
  /** The file went away: renamed, to the editor address given, or deleted. Syncing has stopped. */
  closed?(reason: 'moved' | 'deleted', to?: string): void;
}

export interface SyncOptions {
  /** The origin, '' in a browser. */
  base: string;
  collection: string;
  project: string;
  path: string;
  epoch: string;
  /** The session's CSRF value, sent with every write; the browser's cookie is the credential. */
  csrf?: string;
  /** Extra request headers: a bearer token, for a caller that is not a signed-in browser. */
  headers?: Record<string, string>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Sync {
  private epoch: string;
  private closed = false;
  private pushing = false;
  /** The version the last push's answer named; nothing more is sent until the stream gets there. */
  private awaitVersion = 0;
  private connected = false;
  private streamAbort: AbortController | null = null;
  private selection: { anchor: number; head: number } | null = null;
  private presenceBusy = false;
  private failures = 0;
  private lastStatus: Status | null = null;

  constructor(
    private readonly host: SyncHost,
    private readonly opts: SyncOptions,
  ) {
    this.epoch = opts.epoch;
  }

  start(): void {
    void this.streamLoop();
  }

  close(): void {
    this.closed = true;
    this.streamAbort?.abort();
  }

  /** Call after every transaction; cheap when there is nothing to send. */
  changed(): void {
    this.schedulePush();
    this.report();
  }

  /**
   * Resolves once everything typed on this page so far has been taken by the
   * server (or after `timeoutMs`, whichever is first), so that a compile asked
   * for now sees the last keystrokes.
   */
  whenSynced(timeoutMs = 5000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve) => {
      const check = () => {
        if (sendableUpdates(this.host.state()).length === 0) resolve(true);
        else if (Date.now() > deadline) resolve(false);
        else setTimeout(check, 25);
      };
      check();
    });
  }

  select(anchor: number, head: number): void {
    this.selection = { anchor, head };
    void this.sendPresence();
  }

  private url(route: string, extra: Record<string, string | number> = {}): string {
    const q = new URLSearchParams({ path: this.opts.path });
    for (const [k, v] of Object.entries(extra)) q.set(k, String(v));
    return `${this.opts.base}/api/projects/${encodeURIComponent(this.opts.collection)}/${encodeURIComponent(this.opts.project)}/${route}?${q}`;
  }

  private report(): void {
    let s: Status;
    if (this.failures > 3 && !this.connected) s = 'offline';
    else if (this.lastStatus === 'error') s = 'error';
    else if (!this.connected) s = this.lastStatus === null || this.lastStatus === 'connecting' ? 'connecting' : 'offline';
    else s = sendableUpdates(this.host.state()).length ? 'saving' : 'synced';
    if (s !== this.lastStatus) {
      this.lastStatus = s;
      this.host.status?.(s);
    }
  }

  // ---- down ----

  private async streamLoop(): Promise<void> {
    while (!this.closed) {
      const abort = new AbortController();
      this.streamAbort = abort;
      try {
        const st = this.host.state();
        const res = await fetch(
          this.url('events', { epoch: this.epoch, version: getSyncedVersion(st), client: getClientID(st) }),
          { signal: abort.signal, headers: { ...this.opts.headers, Accept: 'text/event-stream' } },
        );
        if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
        this.connected = true;
        this.failures = 0;
        this.report();
        this.schedulePush();
        void this.sendPresence();
        await this.readEvents(res.body, abort);
      } catch {
        // fall through to reconnect
      }
      this.connected = false;
      if (this.closed) break;
      this.failures++;
      this.report();
      await sleep(Math.min(5000, 250 * 2 ** Math.min(this.failures, 5)));
    }
  }

  private async readEvents(body: ReadableStream<Uint8Array>, abort: AbortController): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) return;
      buf += decoder.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        let data = '';
        for (const line of block.split('\n')) if (line.startsWith('data: ')) data += line.slice(6);
        if (!data) continue;
        if (!this.handle(JSON.parse(data))) {
          abort.abort();
          return;
        }
      }
    }
  }

  /** Returns false when the stream no longer matches this page and must be reopened. */
  private handle(ev: any): boolean {
    const st = this.host.state();
    if (ev.type === 'updates') {
      if (ev.from !== getSyncedVersion(st)) return false;
      const updates = ev.updates.map((u: { clientID: string; changes: unknown }) => ({
        clientID: u.clientID,
        changes: ChangeSet.fromJSON(u.changes),
      }));
      this.host.dispatch(receiveUpdates(st, updates));
      this.schedulePush();
      void this.sendPresence();
      this.report();
    } else if (ev.type === 'reset') {
      const lost = sendableUpdates(st).length > 0;
      this.epoch = ev.epoch;
      this.awaitVersion = 0;
      this.host.reset(ev.doc, ev.version, lost);
      this.report();
    } else if (ev.type === 'presence') {
      const p: Peer = ev.peer;
      // The server gives positions in the text at its version, which is this
      // page's synced version; carry them over this page's unsent changes.
      let { anchor, head } = p;
      for (const u of sendableUpdates(st)) {
        anchor = u.changes.mapPos(anchor, 1);
        head = u.changes.mapPos(head, 1);
      }
      this.host.peer?.({ ...p, anchor, head });
    } else if (ev.type === 'gone') {
      this.host.gone?.(ev.clientID);
    } else if (ev.type === 'compiled') {
      this.host.compiled?.(ev.result);
    } else if (ev.type === 'closed') {
      this.closed = true;
      this.host.closed?.(ev.reason, ev.to);
      return false;
    }
    return true;
  }

  // ---- up ----

  private schedulePush(): void {
    if (this.pushing || this.closed) return;
    const st = this.host.state();
    if (getSyncedVersion(st) < this.awaitVersion) return;
    if (!sendableUpdates(st).length) return;
    void this.push();
  }

  private async push(): Promise<void> {
    this.pushing = true;
    let retryIn = 0;
    try {
      const st = this.host.state();
      const updates = sendableUpdates(st);
      const version = getSyncedVersion(st);
      const res = await fetch(this.url('push'), {
        method: 'POST',
        headers: { ...this.opts.headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          csrf: this.opts.csrf,
          epoch: this.epoch,
          version,
          updates: updates.map((u) => ({ clientID: u.clientID, changes: u.changes.toJSON() })),
        }),
      });
      if (res.ok) {
        this.awaitVersion = (await res.json()).version;
      } else if (res.status === 409) {
        // This page's history is gone; the reopened stream brings the text.
        this.streamAbort?.abort();
      } else {
        this.lastStatus = 'error';
        this.host.status?.('error');
        console.error('push refused', res.status, await res.text());
        return;
      }
    } catch {
      retryIn = 1000;
    } finally {
      this.pushing = false;
    }
    if (retryIn) {
      await sleep(retryIn);
      this.awaitVersion = 0;
    }
    this.schedulePush();
  }

  private async sendPresence(): Promise<void> {
    if (!this.selection || this.presenceBusy || !this.connected) return;
    const st = this.host.state();
    // Positions are sent in the synced text, so only when nothing is unsent.
    if (sendableUpdates(st).length) return;
    const sel = this.selection;
    this.selection = null;
    this.presenceBusy = true;
    try {
      await fetch(this.url('presence'), {
        method: 'POST',
        headers: { ...this.opts.headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          csrf: this.opts.csrf,
          epoch: this.epoch,
          version: getSyncedVersion(st),
          clientID: getClientID(st),
          anchor: sel.anchor,
          head: sel.head,
        }),
      });
    } catch {
      // the next selection change tries again
    } finally {
      this.presenceBusy = false;
    }
    if (this.selection) void this.sendPresence();
  }
}
