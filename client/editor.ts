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
import { Peer, Status, Sync } from './sync';

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
          if (u.docChanged || u.selectionSet) {
            const r = u.state.selection.main;
            sync.select(r.anchor, r.head);
          }
        }),
      ] as Extension[],
    });

  const view = new EditorView({ state: makeState(first.doc, first.version), parent: root });

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
