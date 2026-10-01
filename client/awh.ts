import { Prec, type Extension, type Transaction } from '@codemirror/state';
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import { causeOf, type Cause } from '../../arewehuman/src/editor/recorder';
import { CLIP_MIME, clipPayload, parseClipPayload } from '../../arewehuman/src/editor/clips';

// What the page knows about how each of its edits came about, for the file's
// arewehuman recording (see src/recording.ts): typed (just after a keydown or
// an IME composition step), pasted, undone, moved, or otherwise, as
// arewehuman's own editors decide it. The server, which records the edit,
// adds who made it and when. Only the fact that a key was pressed is used,
// never which key.
//
// Copies and cuts put a random nonce on the clipboard next to the text, under
// a type other programs ignore, and tell the server which characters were
// copied; a paste that carries a known nonce is recorded as a move, a copy,
// or text from another file of the project, instead of an ordinary paste.

export interface EditMeta {
  cause: Cause;
  /** For a paste: the nonce on the clipboard, null if it had none. */
  nonce?: string | null;
  /** For a cut: the nonce put on the clipboard. */
  clip?: string;
  /** When the edit was made (ms, by this page's clock). */
  t: number;
}

const metas = new WeakMap<Transaction, EditMeta>();

/** How a transaction of this page came about, once the extension has seen it. */
export const editMeta = (tr: Transaction | undefined): EditMeta | undefined => (tr ? metas.get(tr) : undefined);

const KEY_WINDOW_MS = 1000;

/** `onCopy` is told of each copy and cut: its nonce and the copied ranges, in the text as it is. */
export function editHints(onCopy: (nonce: string, ranges: { from: number; to: number }[]) => void): Extension {
  let lastKey = -Infinity;
  let lastReplacement = -Infinity;
  let pasteNonce: string | null | undefined;
  let cutNonce: string | null = null;
  // The nonce of the copy or cut under way, added to the clipboard once
  // CodeMirror has put the text there.
  let clipNonce: string | null = null;

  const plugin = ViewPlugin.define((view) => {
    const addNonce = (e: ClipboardEvent) => {
      if (e.defaultPrevented && e.clipboardData && clipNonce) e.clipboardData.setData(CLIP_MIME, clipPayload(clipNonce));
      clipNonce = null;
    };
    view.dom.addEventListener('copy', addNonce);
    view.dom.addEventListener('cut', addNonce);
    return {
      update(u: ViewUpdate) {
        const now = performance.now();
        for (const tr of u.transactions) {
          if (!tr.docChanged) continue;
          const cause = causeOf(tr, { typedOk: now - lastKey < KEY_WINDOW_MS, replacement: now - lastReplacement < 200 });
          const meta: EditMeta = { cause, t: Date.now() };
          if (cause === 'paste') {
            meta.nonce = pasteNonce ?? null;
            pasteNonce = undefined;
          }
          if (tr.isUserEvent('delete.cut') && cutNonce) {
            meta.clip = cutNonce;
            cutNonce = null;
          }
          metas.set(tr, meta);
        }
        if (u.docChanged) lastKey = -Infinity;
      },
      destroy() {
        view.dom.removeEventListener('copy', addNonce);
        view.dom.removeEventListener('cut', addNonce);
      },
    };
  });

  // What CodeMirror copies: the selected ranges, or whole lines when nothing is selected.
  const copied = (view: EditorView) => {
    const { state } = view;
    const sel = state.selection.ranges.filter((r) => !r.empty).map((r) => ({ from: r.from, to: r.to }));
    if (sel.length) return sel;
    const out: { from: number; to: number }[] = [];
    let upto = -1;
    for (const r of state.selection.ranges) {
      const line = state.doc.lineAt(r.from);
      if (line.number > upto) out.push({ from: line.from, to: Math.min(state.doc.length, line.to + 1) });
      upto = line.number;
    }
    return out;
  };

  const handlers = Prec.highest(
    EditorView.domEventHandlers({
      keydown: () => {
        lastKey = performance.now();
        return false;
      },
      compositionstart: () => {
        lastKey = performance.now();
        return false;
      },
      compositionupdate: () => {
        lastKey = performance.now();
        return false;
      },
      beforeinput: (e: InputEvent) => {
        if (e.inputType === 'insertReplacementText') lastReplacement = performance.now();
        return false;
      },
      copy: (_e, view) => {
        clipNonce = crypto.randomUUID();
        onCopy(clipNonce, copied(view));
        return false;
      },
      cut: () => {
        // The server notes the cut characters as it takes the deletion.
        clipNonce = cutNonce = crypto.randomUUID();
        return false;
      },
      paste: (e: ClipboardEvent) => {
        pasteNonce = e.clipboardData ? parseClipPayload(e.clipboardData.getData(CLIP_MIME)) : undefined;
        return false;
      },
    }),
  );
  return [plugin, handlers];
}
