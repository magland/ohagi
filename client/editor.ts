import { Compartment, EditorState, Extension, RangeSetBuilder, StateEffect, StateField } from '@codemirror/state';
import {
  Decoration,
  DecorationSet,
  EditorView,
  WidgetType,
  crosshairCursor,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, defaultHighlightStyle, StreamLanguage, syntaxHighlighting } from '@codemirror/language';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { stex } from '@codemirror/legacy-modes/mode/stex';
import { collab, getClientID } from '@codemirror/collab';
import { CompiledSummary, Peer, Status, Sync } from './sync';

// The editor page: CodeMirror 6 with the collab extension, synced through
// sync.ts, and the other people in the file drawn as coloured cursors. Who
// is typing is the signed-in user; the page carries their CSRF value and
// whether they may write, and the server holds both to account again.

// ---- remote cursors ----

interface RemoteCursor {
  name: string;
  color: string;
  anchor: number;
  head: number;
}

const setPeer = StateEffect.define<{ id: string; cursor: RemoteCursor }>();
const removePeer = StateEffect.define<string>();

class CaretWidget extends WidgetType {
  constructor(
    readonly name: string,
    readonly color: string,
  ) {
    super();
  }
  eq(other: CaretWidget) {
    return other.name === this.name && other.color === this.color;
  }
  toDOM() {
    const el = document.createElement('span');
    el.className = 'peer-caret';
    el.style.borderColor = this.color;
    const label = document.createElement('span');
    label.className = 'peer-label';
    label.style.background = this.color;
    label.textContent = this.name;
    el.appendChild(label);
    return el;
  }
  ignoreEvent() {
    return true;
  }
}

const peersField = StateField.define<Map<string, RemoteCursor>>({
  create: () => new Map(),
  update(peers, tr) {
    let next = peers;
    if (tr.docChanged) {
      next = new Map();
      for (const [id, c] of peers) {
        next.set(id, { ...c, anchor: tr.changes.mapPos(c.anchor, 1), head: tr.changes.mapPos(c.head, 1) });
      }
    }
    for (const e of tr.effects) {
      if (e.is(setPeer)) {
        if (next === peers) next = new Map(peers);
        const len = tr.state.doc.length;
        const c = e.value.cursor;
        next.set(e.value.id, { ...c, anchor: Math.min(c.anchor, len), head: Math.min(c.head, len) });
      } else if (e.is(removePeer)) {
        if (next === peers) next = new Map(peers);
        next.delete(e.value);
      }
    }
    return next;
  },
  provide: (f) =>
    EditorView.decorations.from(f, (peers): DecorationSet => {
      const ranges: { from: number; to: number; deco: Decoration }[] = [];
      for (const c of peers.values()) {
        const from = Math.min(c.anchor, c.head);
        const to = Math.max(c.anchor, c.head);
        if (from < to) {
          ranges.push({ from, to, deco: Decoration.mark({ attributes: { style: `background-color: ${c.color}33` } }) });
        }
        ranges.push({ from: c.head, to: c.head, deco: Decoration.widget({ widget: new CaretWidget(c.name, c.color), side: 1 }) });
      }
      ranges.sort((a, b) => a.from - b.from || a.to - b.to);
      const builder = new RangeSetBuilder<Decoration>();
      for (const r of ranges) builder.add(r.from, r.to, r.deco);
      return builder.finish();
    }),
});

function colorFor(name: string): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)!) % 360;
  return `hsl(${h}, 65%, 45%)`;
}

// ---- the page ----

const STATUS_TEXT: Record<Status, string> = {
  connecting: 'Connecting',
  synced: 'Saved',
  saving: 'Saving',
  offline: 'Offline, reconnecting',
  error: 'Error: reload the page',
  deleted: 'This file was deleted',
};

async function main() {
  const root = document.getElementById('editor')!;
  const collection = root.dataset.collection!;
  const project = root.dataset.project!;
  const path = root.dataset.path!;
  const csrf = root.dataset.csrf!;
  const writable = root.dataset.writable === '1';
  const statusEl = document.getElementById('status')!;
  const peersEl = document.getElementById('peers')!;

  const q = new URLSearchParams({ path });
  const first = await (await fetch(`/api/projects/${encodeURIComponent(collection)}/${encodeURIComponent(project)}/doc?${q}`)).json();

  const names = new Map<string, string>();
  const showPeers = () => {
    peersEl.replaceChildren(
      ...[...new Set(names.values())].sort().map((n) => {
        const s = document.createElement('span');
        s.className = 'peer-chip';
        s.style.background = colorFor(n);
        s.textContent = n;
        return s;
      }),
    );
  };

  let sync: Sync;
  const editable = new Compartment();
  // Set once the PDF pane is ready; until then a change has nothing to schedule.
  let onTextChanged: () => void = () => undefined;
  const makeState = (doc: string, version: number, clientID?: string): EditorState =>
    EditorState.create({
      doc,
      extensions: [
        collab({ startVersion: version, clientID }),
        editable.of(EditorState.readOnly.of(!writable)),
        peersField,
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightSpecialChars(),
        history(),
        drawSelection(),
        dropCursor(),
        EditorState.allowMultipleSelections.of(true),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        bracketMatching(),
        rectangularSelection(),
        crosshairCursor(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        StreamLanguage.define(stex),
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({ spellcheck: 'true', autocorrect: 'off', autocapitalize: 'off' }),
        keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
        EditorView.updateListener.of((u) => {
          if (!sync) return;
          sync.changed();
          if (u.docChanged) onTextChanged();
          if (u.docChanged || u.selectionSet) {
            const r = u.state.selection.main;
            sync.select(r.anchor, r.head);
          }
        }),
      ] as Extension[],
    });

  const view = new EditorView({ state: makeState(first.doc, first.version), parent: root });

  // ---- the PDF pane ----

  const api = `/api/projects/${encodeURIComponent(collection)}/${encodeURIComponent(project)}`;
  const fileUrl = (rel: string) =>
    `/${encodeURIComponent(collection)}/${encodeURIComponent(project)}/edit/${rel.split('/').map(encodeURIComponent).join('/')}`;
  const $ = (id: string) => document.getElementById(id)!;
  const recompileBtn = $('recompile') as HTMLButtonElement;
  const compileStatus = $('compile-status');
  const issuesBtn = $('show-issues') as HTMLButtonElement;
  const issues = $('issues');
  const frame = $('pdf-frame') as HTMLIFrameElement;
  const empty = $('pdf-empty');
  const download = $('pdf-download');
  let shownPdf = '';

  const goToLine = (line: number) => {
    const doc = view.state.doc;
    const at = doc.line(Math.max(1, Math.min(line, doc.lines))).from;
    view.dispatch({ selection: { anchor: at }, scrollIntoView: true });
    view.focus();
  };

  const showResult = (r: CompiledSummary, log?: string) => {
    const secs = (r.durationMs / 1000).toFixed(1);
    const said: Record<string, string> = {
      success: `Compiled in ${secs} s`,
      failure: `Compiled with errors in ${secs} s`,
      timeout: 'The compile took too long and was stopped',
      error: 'Could not compile',
    };
    compileStatus.textContent = said[r.status] ?? r.status;
    compileStatus.className = `small status-${r.status}`;
    const n = r.errors.length;
    issuesBtn.hidden = n === 0 && r.warnings === 0;
    issuesBtn.textContent = n ? `${n} error${n === 1 ? '' : 's'}` : `${r.warnings} warning${r.warnings === 1 ? '' : 's'}`;
    const list = document.createElement('ul');
    for (const e of r.errors) {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = e.file && e.line ? `${fileUrl(e.file)}#L${e.line}` : '#';
      const where = document.createElement('span');
      where.className = 'where';
      where.textContent = e.file ? `${e.file}${e.line ? `:${e.line}` : ''}` : '';
      a.append(where, document.createTextNode(e.message));
      a.addEventListener('click', (ev) => {
        if (e.file === path && e.line) {
          ev.preventDefault();
          goToLine(e.line);
        } else if (!e.file) ev.preventDefault();
      });
      li.append(a);
      list.append(li);
    }
    issues.replaceChildren(list);
    if (log !== undefined) {
      const details = document.createElement('details');
      const summary = document.createElement('summary');
      summary.textContent = 'Log';
      const pre = document.createElement('pre');
      pre.textContent = log;
      details.append(summary, pre);
      issues.append(details);
    }
    if (n === 0) issues.hidden = true;
    else if (r.status !== 'success') issues.hidden = false;
    if (r.pdf && r.finished !== shownPdf) {
      shownPdf = r.finished;
      frame.src = `${api}/output.pdf?t=${encodeURIComponent(r.finished)}#view=FitH`;
      frame.hidden = false;
      empty.hidden = true;
      download.hidden = false;
    }
  };
  issuesBtn.addEventListener('click', () => {
    issues.hidden = !issues.hidden;
  });

  let compiling = false;
  const recompile = async () => {
    if (compiling) return;
    compiling = true;
    recompileBtn.disabled = true;
    compileStatus.textContent = 'Compiling…';
    compileStatus.className = 'small muted';
    try {
      // What was just typed goes to the server before the compile is asked for.
      await sync.whenSynced();
      const res = await fetch(`${api}/compile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ csrf }),
      });
      const r = await res.json();
      if (!res.ok) throw new Error(r.error ?? `HTTP ${res.status}`);
      showResult(r, r.log);
    } catch (e) {
      compileStatus.textContent = `Could not compile: ${e instanceof Error ? e.message : e}`;
      compileStatus.className = 'small status-error';
    } finally {
      compiling = false;
      recompileBtn.disabled = false;
    }
  };
  recompileBtn.addEventListener('click', () => void recompile());

  // Auto-compile: a compile a moment after the text stops changing, whoever
  // changed it. The choice is this browser's, kept in its storage.
  const auto = $('auto-compile') as HTMLInputElement;
  try {
    auto.checked = localStorage.getItem('ohagi-auto-compile') === '1';
  } catch {
    // storage blocked; the box starts off
  }
  auto.addEventListener('change', () => {
    try {
      localStorage.setItem('ohagi-auto-compile', auto.checked ? '1' : '0');
    } catch {
      // not remembered, which is all that is lost
    }
  });
  let autoTimer: ReturnType<typeof setTimeout> | null = null;
  const textChanged = () => {
    if (!auto.checked) return;
    if (autoTimer) clearTimeout(autoTimer);
    autoTimer = setTimeout(() => void recompile(), 2500);
  };
  onTextChanged = textChanged;
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'Enter')) {
      e.preventDefault();
      void recompile();
    }
  });
  // The last compile, if there has been one, so the pane opens with the PDF.
  void fetch(`${api}/compile`).then(async (res) => {
    if (res.ok) {
      const r = await res.json();
      showResult(r, r.log);
    }
  });
  // An address ending in #L<line> opens at that line, which is how an error
  // in another file is followed.
  const lineMatch = /^#L(\d+)$/.exec(location.hash);
  if (lineMatch) goToLine(parseInt(lineMatch[1], 10));

  sync = new Sync(
    {
      state: () => view.state,
      dispatch: (tr) => view.dispatch(tr),
      reset: (doc, version, lostEdits) => {
        const selection = view.state.selection.main.head;
        view.setState(makeState(doc, version, getClientID(view.state)));
        view.dispatch({ selection: { anchor: Math.min(selection, doc.length) } });
        names.clear();
        showPeers();
        if (lostEdits) alert('The file changed on the server in a way your last few edits could not be merged into. They were not saved.');
      },
      status: (s) => {
        statusEl.textContent = STATUS_TEXT[s];
        statusEl.className = `editor-status status-${s}`;
        statusEl.dataset.state = s;
      },
      peer: (p: Peer) => {
        names.set(p.clientID, p.name);
        showPeers();
        view.dispatch({ effects: setPeer.of({ id: p.clientID, cursor: { name: p.name, color: colorFor(p.name), anchor: p.anchor, head: p.head } }) });
      },
      compiled: (r) => showResult(r),
      closed: (reason, to) => {
        if (reason === 'moved' && to) {
          location.replace(to);
          return;
        }
        view.dispatch({ effects: editable.reconfigure(EditorState.readOnly.of(true)) });
        statusEl.textContent = STATUS_TEXT.deleted;
        statusEl.className = 'editor-status status-error';
        statusEl.dataset.state = 'deleted';
      },
      gone: (id) => {
        names.delete(id);
        showPeers();
        view.dispatch({ effects: removePeer.of(id) });
      },
    },
    { base: '', collection, project, path, epoch: first.epoch, csrf },
  );
  sync.start();
  const r = view.state.selection.main;
  sync.select(r.anchor, r.head);
  view.focus();
  window.addEventListener('beforeunload', (e) => {
    if (statusEl.dataset.state === 'saving' || statusEl.dataset.state === 'offline') e.preventDefault();
  });
}

void main();
