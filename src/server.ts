import './branding';
import compression from 'compression';
import { createHash } from 'crypto';
import express, { NextFunction, Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { registerAccountWeb } from '../../mochiforge/src/accountweb';
import { registerAdminWeb } from '../../mochiforge/src/adminweb';
import { registerUsersApi } from '../../mochiforge/src/api/users';
import { registerBackupRoutes } from '../../mochiforge/src/api/backup';
import { shelfLayout } from './backup';
import { registerAssets } from '../../mochiforge/src/assets';
import { loadConfig } from '../../mochiforge/src/config';
import { clientKey, createAuthLimiter, createLimiter } from '../../mochiforge/src/limit';
import { getViewer, renewSession } from '../../mochiforge/src/session';
import { setActiveTheme } from '../../mochiforge/src/themes';
import { registerApi } from './api';
import { Compiler } from './compile';
import { Docs } from './docs';
import { faviconSvg } from './logo';
import { listCollectionNames, listProjectNames, projectDir, projectRole, removeUserGrants } from './projects';
import { setNaming } from '../../mochiforge/src/naming';
import { errorPage } from './views';
import { registerWeb } from './web';

// One Express app, the shape of mochiforge's server and dango's: compression,
// per-address rate limits, a strict CSP with no inline script, immutable
// hashed assets, sliding sessions, and every route reading the shelf
// directory on demand. What is mochi's is registered from mochi: the page
// assets and the sign-in and account pages. What is ohagi's is the shelf's
// pages, the editor, and the sync API the editor talks through.

/**
 * What a shelf page may load, and from where; mochi's policy (see its
 * src/server.ts for the reasoning), with connect-src 'self' carrying the
 * editor's sync and event stream.
 */
const APP_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  'img-src * data:',
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self' https://github.com",
  "frame-ancestors 'self'",
].join('; ');

function isRateExempt(req: Request): boolean {
  return req.path.startsWith('/assets/') || req.path === '/favicon.svg' || req.path === '/favicon.ico';
}

// An editor's event stream must reach the page as it is written; compression
// would buffer it. The sync pushes are small and gain nothing either.
const UNCOMPRESSED = /^\/api\/projects\/[^/]+\/[^/]+\/(events|push|presence|output\.pdf)$|^\/api\/backup\//;

function isCompressible(req: Request, res: Response): boolean {
  if (UNCOMPRESSED.test(req.path)) return false;
  return compression.filter(req, res);
}

/** A built file of ohagi's own, with a tag naming its bytes. */
interface Built {
  body: Buffer;
  tag: string;
}

/**
 * Where the editor bundle and ohagi's stylesheet were built to: dist/static,
 * reached from src/ under tsx or from dist/ohagi/src/ when compiled.
 */
export function findStaticDir(): string {
  const candidates = [path.join(__dirname, '..', 'dist', 'static'), path.join(__dirname, '..', '..', 'static')];
  for (const c of candidates) if (fs.existsSync(path.join(c, 'editor.js'))) return c;
  throw new Error('The editor bundle is not built; run npm run build:client.');
}

function loadBuilt(file: string): Built {
  const body = fs.readFileSync(file);
  return { body, tag: createHash('sha256').update(body).digest('hex').slice(0, 12) };
}

export function createApp(root: string, docs: Docs, compiler: Compiler, staticDir = findStaticDir()) {
  const app = express();
  app.disable('x-powered-by');
  app.set('query parser', 'simple');
  const config = loadConfig(root);
  // One hop, not `true`, for mochi's reason: req.ip must be the address the
  // proxy saw, or every per-address limit is the client's to choose.
  app.set('trust proxy', config.network.trustProxy ? 1 : false);

  app.use(compression({ filter: isCompressible }));

  const authLimiter = createAuthLimiter(config.limits.authFailures);
  const requestLimiter = createLimiter({
    limit: config.limits.requestsPerMinute,
    windowMs: 60000,
    maxKeys: 20000,
  });

  // The theme is shelf state, re-read (stat-cached) per request so a
  // hand-edited config.json takes effect without a restart.
  app.use((_req, _res, next) => {
    setActiveTheme(loadConfig(root).theme);
    next();
  });

  app.use((req, res, next) => {
    if (isRateExempt(req)) return next();
    const decision = requestLimiter.hit(clientKey(req));
    if (decision.ok) return next();
    res.status(429).setHeader('Retry-After', String(decision.retryAfter));
    res.type('html').send(errorPage(429, 'Too many requests from this address. Try again in a moment.', { viewer: null }));
  });

  app.use((_req, res, next) => {
    res.setHeader('Content-Security-Policy', APP_CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  });

  // ---- assets: mochi's, then ohagi's own ----

  registerAssets(app, { favicon: () => faviconSvg() });

  const editorJs = loadBuilt(path.join(staticDir, 'editor.js'));
  const ohagiCss = loadBuilt(path.join(staticDir, 'ohagi.css'));
  // Every page the shared layout draws, mochi's sign-in and account pages
  // among them, links ohagi's stylesheet after mochi's.
  setNaming({ pageHead: `\n<link rel="stylesheet" href="/assets/ohagi.css?v=${ohagiCss.tag}">` });
  const serveBuilt = (built: Built, type: string) => (req: Request, res: Response) => {
    const fresh = String(req.query.v ?? '') === built.tag;
    res
      .type(type)
      .set('Cache-Control', fresh ? 'public, max-age=31536000, immutable' : 'no-cache')
      .send(built.body);
  };
  app.get('/assets/editor.js', serveBuilt(editorJs, 'text/javascript'));
  app.get('/assets/ohagi.css', serveBuilt(ohagiCss, 'text/css'));

  // The jump box's list: every project this viewer can open, as
  // collection/name, which is the shape mochi's page script searches.
  app.get('/assets/repos.json', (req, res) => {
    const viewer = getViewer(req, root);
    const out: { name: string }[] = [];
    for (const c of listCollectionNames(root)) {
      for (const p of listProjectNames(root, c)) {
        if (projectRole(root, viewer?.auth ?? null, { collection: c, name: p, dir: projectDir(root, c, p) }) !== null) {
          out.push({ name: `${c}/${p}` });
        }
      }
    }
    res.set('Cache-Control', 'private, no-cache').json(out);
  });

  // Sliding sessions, after the cacheable assets for mochi's reason: a
  // Set-Cookie must never ride on a response a shared cache stores.
  app.use((req, res, next) => {
    renewSession(req, res, root);
    next();
  });

  // JSON bodies, as large as a text file the editor accepts.
  app.use('/api', express.json({ limit: '16mb' }));
  // Backup, over mochi's protocol: a manifest of the shelf's files and a bulk
  // fetch of named ones, site admins only.
  registerBackupRoutes(app, root, authLimiter, shelfLayout(root));
  // A finished compile is announced on every open editor's stream of the
  // project, so each PDF pane refreshes whoever pressed the button.
  compiler.onCompiled((ref, r) => {
    docs.announceProject(ref.dir, {
      type: 'compiled',
      result: { status: r.status, main: r.main, errors: r.errors, warnings: r.warnings, pdf: r.pdf, durationMs: r.durationMs, finished: r.finished },
    });
  });
  registerApi(app, root, authLimiter, docs, compiler);
  // Who the caller is, the users, and their tokens: mochi's own routes, so
  // mochi's user commands work against a shelf as they do against a vault.
  registerUsersApi(app, root, authLimiter, { removeUserGrants });
  // Signing in and out, the account page, passkeys, and the profile, and the
  // site admin's pages (users, GitHub sign-in, the theme): mochi's own routes,
  // the same ones a vault serves.
  registerAccountWeb(app, root, authLimiter);
  registerAdminWeb(app, root, { removeUserGrants });
  registerWeb(app, root, docs, editorJs.tag);

  app.use((req, res) => {
    res.status(404).type('html').send(errorPage(404, 'Page not found', { viewer: getViewer(req, root) }));
  });

  app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) {
      console.error(err);
      res.end();
      return;
    }
    let viewer = null;
    try {
      viewer = getViewer(req, root);
    } catch {
      viewer = null;
    }
    const status = (err as Error & { statusCode?: unknown }).statusCode ?? (err as Error & { status?: unknown }).status;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      const message =
        (err as Error & { type?: unknown }).type === 'entity.too.large'
          ? 'What you submitted is larger than this form accepts.'
          : 'The request could not be read; go back and try again.';
      if (req.path.startsWith('/api/')) {
        res.status(status).json({ error: message });
        return;
      }
      res.status(status).type('html').send(errorPage(status, message, { viewer }));
      return;
    }
    console.error(err);
    if (req.path.startsWith('/api/')) {
      res.status(500).json({ error: 'internal server error' });
      return;
    }
    res.status(500).type('html').send(errorPage(500, 'Internal server error', { viewer }));
  });

  return app;
}
