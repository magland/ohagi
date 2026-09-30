import express, { NextFunction, Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { DocEvent, PushRefused } from './livedoc';
import { NotFound, Shelf } from './shelf';

// The prototype's server: collections at /<collection> and projects at
// /<collection>/<project>, as mochi addresses repositories, and the editor, with the four API routes the editor syncs through. There is
// no sign-in yet; that comes from mochiforge's modules, as it does in dango,
// and until then the server should only listen on localhost.

/** A stream whose reader has stopped reading is closed rather than buffered. */
const MAX_STREAM_BUFFER = 8 * 1024 * 1024;
const HEARTBEAT_MS = 25_000;

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function page(title: string, body: string, head = ''): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="stylesheet" href="/assets/ohagi.css">${head}
</head><body>${body}</body></html>`;
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function createApp(shelf: Shelf, staticDir: string): express.Express {
  const app = express();
  app.disable('x-powered-by');

  // Page assets sit under a name collections may not take, as in mochi.
  app.use('/assets', express.static(staticDir, { maxAge: 0 }));

  const enc = encodeURIComponent;
  const crumbs = (collection: string, project?: string) =>
    `<a href="/${enc(collection)}">${esc(collection)}</a>` + (project ? ` / <a href="/${enc(collection)}/${enc(project)}">${esc(project)}</a>` : '');

  app.get('/', (_req, res) => {
    const items = shelf.collections().map((c) => {
      const n = shelf.projects(c).length;
      return `<li><a href="/${enc(c)}">${esc(c)}</a> <span class="size">${n} project${n === 1 ? '' : 's'}</span></li>`;
    });
    res.send(page('ohagi', `<main class="list"><h1>Collections</h1><ul>${items.join('') || '<li>None yet.</li>'}</ul></main>`));
  });

  app.get('/:collection', (req, res) => {
    const { collection } = req.params;
    const items = shelf.projects(collection).map((p) => `<li><a href="/${enc(collection)}/${enc(p)}">${esc(p)}</a></li>`);
    res.send(page(collection, `<main class="list"><p><a href="/">Collections</a></p><h1>${esc(collection)}</h1><ul>${items.join('') || '<li>No projects yet.</li>'}</ul></main>`));
  });

  app.get('/:collection/:project', (req, res) => {
    const { collection, project } = req.params;
    const files = shelf.files(collection, project);
    const rows = files.map((f) => {
      const name = esc(f.path);
      const link = f.text ? `<a href="/${enc(collection)}/${enc(project)}/f/${f.path.split('/').map(enc).join('/')}">${name}</a>` : name;
      return `<li>${link} <span class="size">${fmtSize(f.size)}</span></li>`;
    });
    res.send(page(`${collection}/${project}`, `<main class="list"><p>${crumbs(collection)}</p><h1>${esc(project)}</h1><ul>${rows.join('')}</ul></main>`));
  });

  app.get('/:collection/:project/f/*', (req, res) => {
    const { collection, project } = req.params;
    const rel = Shelf.cleanPath((req.params as unknown as Record<string, string>)[0]);
    shelf.doc(collection, project, rel); // 404 now rather than in the page
    const body = `<header class="bar">
  ${crumbs(collection, project)} / <b>${esc(rel)}</b>
  <span id="peers"></span><span id="status">Connecting</span>
</header>
<div id="editor" data-collection="${esc(collection)}" data-project="${esc(project)}" data-path="${esc(rel)}"></div>
<script src="/assets/editor.js"></script>`;
    res.send(page(`${rel} · ${collection}/${project}`, body));
  });

  // ---- API ----

  const api = express.Router();
  api.use(express.json({ limit: '16mb' }));

  const docFor = (req: Request) => shelf.doc(req.params.collection, req.params.project, String(req.query.path ?? ''));

  api.get('/projects/:collection/:project/doc', (req, res) => {
    const doc = docFor(req);
    res.json({ epoch: doc.epoch, version: doc.version, doc: doc.text.toString() });
  });

  api.post('/projects/:collection/:project/push', (req, res) => {
    const doc = docFor(req);
    const { epoch, version, updates } = req.body ?? {};
    if (typeof epoch !== 'string' || !Number.isInteger(version) || !Array.isArray(updates)) {
      res.status(400).json({ error: 'epoch, version, and updates required' });
      return;
    }
    try {
      res.json(doc.push(epoch, version, updates));
    } catch (e) {
      if (e instanceof PushRefused) res.status(409).json({ error: 'history moved on; reconnect' });
      else res.status(400).json({ error: (e as Error).message });
    }
  });

  api.post('/projects/:collection/:project/presence', (req, res) => {
    const doc = docFor(req);
    const { epoch, version, clientID, name, anchor, head } = req.body ?? {};
    if (
      typeof epoch !== 'string' ||
      !Number.isInteger(version) ||
      typeof clientID !== 'string' ||
      typeof name !== 'string' ||
      !Number.isInteger(anchor) ||
      !Number.isInteger(head)
    ) {
      res.status(400).json({ error: 'bad presence' });
      return;
    }
    doc.presence(epoch, version, { clientID: clientID.slice(0, 40), name: name.slice(0, 60), anchor, head });
    res.json({});
  });

  api.get('/projects/:collection/:project/events', (req, res) => {
    const doc = docFor(req);
    const clientID = String(req.query.client ?? '');
    const epoch = String(req.query.epoch ?? '');
    const version = Number(req.query.version);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
      Connection: 'keep-alive',
    });
    res.write(': open\n\n');
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(beat);
      unsubscribe();
      res.end();
    };
    const send = (event: DocEvent) => {
      if (closed) return;
      if (res.writableLength > MAX_STREAM_BUFFER) {
        close();
        return;
      }
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    };
    const unsubscribe = doc.subscribe({ clientID, send }, epoch, Number.isInteger(version) ? version : -1);
    const beat = setInterval(() => res.write(': beat\n\n'), HEARTBEAT_MS);
    req.on('close', close);
  });

  app.use('/api', api);

  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err);
    if (err instanceof NotFound) {
      res.status(404).send(page('Not found', `<main class="list"><h1>Not found</h1><p>${esc(err.message)}</p></main>`));
      return;
    }
    console.error(err);
    res.status(500).send('Internal error');
  });

  return app;
}

/** Where the built page assets are: dist/static beside the compiled server, or the checkout's when run from source. */
export function findStaticDir(): string {
  const candidates = [path.join(__dirname, '..', 'static'), path.join(__dirname, '..', 'dist', 'static')];
  for (const c of candidates) if (fs.existsSync(path.join(c, 'editor.js'))) return c;
  throw new Error('editor bundle not built; run npm run build:client');
}
