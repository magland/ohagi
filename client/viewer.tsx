import { createRoot } from 'react-dom/client';
import { ProjectView, type NamedRecording } from '../../arewehuman/src/viewer/ProjectView';
import { parseRecording } from '../../arewehuman/src/prov/log';

// The who-wrote-what page of a recorded file: arewehuman's viewer
// (src/viewer/ProjectView.tsx in arewehuman), in a frame of its own so that
// its styles and ohagi's stay apart. The server gives the file's text, its
// recordings, and the project's other recordings, which text may have been
// moved or copied from (see src/api.ts, awh/record).

interface Raw {
  name: string;
  log: string;
}

const el = document.getElementById('root')!;

function parse(list: Raw[]): NamedRecording[] {
  return list.flatMap((r) => {
    try {
      return [{ name: r.name, doc: parseRecording(r.log) }];
    } catch {
      return [];
    }
  });
}

async function main() {
  const res = await fetch(el.dataset.api!);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const d = (await res.json()) as { title: string; text: string; recs: Raw[]; others: Raw[] };
  const recs = parse(d.recs);
  if (!recs.length) {
    el.innerHTML = '<div class="viewer"><p class="muted">This file has no recording yet. It begins with the first edit made after recording was set up.</p></div>';
    return;
  }
  createRoot(el).render(<ProjectView title={d.title} md={d.text} recs={recs} others={parse(d.others)} />);
}

main().catch((e) => {
  el.textContent = `The recording could not be shown: ${e instanceof Error ? e.message : e}`;
});
