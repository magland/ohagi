import { GlobalWorkerOptions, getDocument, type PDFDocumentLoadingTask, type PDFDocumentProxy } from 'pdfjs-dist';

// The PDF pane's viewer: pdf.js drawing each page onto a canvas, so the page
// knows where it is clicked, which the browser's own viewer never tells it.
// A double-click on a page reports the page and the point, in PDF points from
// the page's top left, which is what SyncTeX takes.
//
// The PDF comes from a document anyone with write access can author, so
// nothing in it may run. pdf.js 6's core library, which is all this uses,
// never runs a PDF's scripts (only its full viewer, with a sandbox, would)
// and evaluates no generated code; version 5's did, and had an advisory
// for it (GHSA-hq66-cqwq-w95j), which is why this is 6.

export interface PdfPoint {
  page: number;
  x: number;
  y: number;
}

export class PdfView {
  private doc: PDFDocumentProxy | null = null;
  private task: PDFDocumentLoadingTask | null = null;
  private url = '';
  private rendering = 0;
  private resizeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly box: HTMLElement,
    workerSrc: string,
    private readonly onPoint: (p: PdfPoint) => void
  ) {
    GlobalWorkerOptions.workerSrc = workerSrc;
    new ResizeObserver(() => {
      if (this.resizeTimer) clearTimeout(this.resizeTimer);
      this.resizeTimer = setTimeout(() => void this.render(), 150);
    }).observe(box);
  }

  /** Show the PDF at this address, keeping the reader's place when it is a newer build of the same one. */
  async load(url: string): Promise<void> {
    this.url = url;
    const task = getDocument({ url });
    const doc = await task.promise;
    if (this.url !== url) {
      void task.destroy();
      return;
    }
    const oldTask = this.task;
    this.doc = doc;
    this.task = task;
    await this.render();
    if (oldTask) void oldTask.destroy();
  }

  private async render(): Promise<void> {
    const doc = this.doc;
    if (!doc) return;
    const run = ++this.rendering;
    const width = this.box.clientWidth - 24;
    if (width <= 0) return;
    // The reader's place, as a share of the whole, kept across the redraw.
    const place = this.box.scrollHeight > this.box.clientHeight ? this.box.scrollTop / (this.box.scrollHeight - this.box.clientHeight) : 0;
    const ratio = window.devicePixelRatio || 1;
    const pages: HTMLElement[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      if (run !== this.rendering) return;
      const base = page.getViewport({ scale: 1 });
      const scale = width / base.width;
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width * ratio);
      canvas.height = Math.floor(viewport.height * ratio);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;
      const holder = document.createElement('div');
      holder.className = 'pdf-page';
      holder.title = 'Double-click to go to the source';
      holder.append(canvas);
      holder.addEventListener('dblclick', (e) => {
        const rect = canvas.getBoundingClientRect();
        this.onPoint({ page: n, x: (e.clientX - rect.left) / scale, y: (e.clientY - rect.top) / scale });
      });
      await page.render({ canvas, viewport, transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0] }).promise;
      if (run !== this.rendering) return;
      pages.push(holder);
    }
    this.box.replaceChildren(...pages);
    this.box.scrollTop = place * (this.box.scrollHeight - this.box.clientHeight);
  }
}
