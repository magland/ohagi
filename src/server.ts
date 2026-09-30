import express, { NextFunction, Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { DocEvent, PushRefused } from './livedoc';
import { NotFound, Shelf } from './shelf';

// The prototype's server: a list of projects, a list of a project's files,
// and the editor, with the four API routes the editor syncs through. There is
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
<link rel="stylesheet" href="/static/ohagi.css">${head}
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

  app.use('/static', express.static(staticDir, { maxAge: 0 }));

  app.get('/', (_req, res) => {
    const items = shelf.projects().map((p) => `<li><a href="/p/${encodeURIComponent(p)}">${esc(p)}</a></li>`);
    res.send(page('ohagi', `<main class="list"><h1>Projects</h1><ul>${items.join('') || '<li>None yet.</li>'}</ul></main>`));
  });

  app.get('/p/:project', (req, res) => {
    const project = req.params.project;
    const files = shelf.files(project);
    const rows = files.map((f) => {
      const name = esc(f.path);
      const link = f.text ? `<a href="/p/${encodeURIComponent(project)}/f/${f.path.split('/').map(encodeURIComponent).join('/')}">${name}</a>` : name;
      return `<li>${link} <span class="size">${fmtSize(f.size)}</span></li>`;
    });
    res.send(page(project, `<main class="list"><p><a href="/">Projects</a></p><h1>${esc(project)}</h1><ul>${rows.join('')}</ul></main>`));
  });

  app.get('/p/:project/f/*', (req, res) => {
    const project = req.params.project;
    const rel = Shelf.cleanPath((req.params as unknown as Record<string, string>)[0]);
    shelf.doc(project, rel); // 404 now rather than in the page
    const body = `<header class="bar">
  <a href="/p/${encodeURIComponent(project)}">${esc(project)}</a> / <b>${esc(rel)}</b>
  <span id="peers"></span><span id="status">Connecting</span>
</header>
<div id="editor" data-project="${esc(project)}" data-path="${esc(rel)}"></div>
<script src="/static/editor.js"></script>`;
    res.send(page(`${rel} · ${project}`, body));
  });

  // ---- API ----

  const api = express.Router();
  api.use(express.json({ limit: '16mb' }));

  const docFor = (req: Request) => shelf.doc(req.params.project, String(req.query.path ?? ''));

  api.get('/p/:project/doc', (req, res) => {
    const doc = docFor(req);
    res.json({ epoch: doc.epoch, version: doc.version, doc: doc.text.toString() });
  });

  api.post('/p/:project/push', (req, res) => {
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

  api.post('/p/:project/presence', (req, res) => {
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

  api.get('/p/:project/events', (req, res) => {
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
