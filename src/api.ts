import express, { Express, Request, Response } from 'express';
import { apiError, requireApiAuth } from '../../mochiforge/src/api/auth';
import { AuthLimiter } from '../../mochiforge/src/limit';
import { Role, atLeast } from '../../mochiforge/src/perms';
import { checkCsrf, getViewer } from '../../mochiforge/src/session';
import { AuthResult } from '../../mochiforge/src/vault';
import { DocNotFound, Docs } from './docs';
import { DocEvent, LiveDoc, PushRefused } from './livedoc';
import { ProjectRef, findProject, projectRole } from './projects';

// The JSON API. Every route takes either of mochi's two credentials: a bearer
// token, as scripts and the CLI send, or the browser's session cookie, in
// which case a write must also carry the session's CSRF value in its body, as
// every form of mochi's does. Who may do what is mochi's roles: reading a
// file and following it take read on the project, pushing a change takes
// write. A project the caller cannot see answers 404, as a private
// repository does in a vault.

/** A stream whose reader has stopped reading is closed rather than buffered. */
const MAX_STREAM_BUFFER = 8 * 1024 * 1024;
const HEARTBEAT_MS = 25_000;

interface Access {
  auth: AuthResult;
  ref: ProjectRef;
  role: Role;
  doc: LiveDoc;
}

export function registerApi(app: Express, root: string, limiter: AuthLimiter, docs: Docs): void {
  const json = express.json({ limit: '16mb' });

  /** The caller, by bearer token or by session; null having answered. */
  function caller(req: Request, res: Response, write: boolean): AuthResult | null {
    if (req.get('authorization')) return requireApiAuth(root, limiter, req, res);
    const viewer = getViewer(req, root);
    if (!viewer) {
      apiError(res, 401, 'not signed in');
      return null;
    }
    if (write && !checkCsrf(req, viewer)) {
      apiError(res, 403, 'the page has expired; reload it');
      return null;
    }
    return viewer.auth;
  }

  function access(req: Request, res: Response, min: Role, write = false): Access | null {
    const auth = caller(req, res, write);
    if (!auth) return null;
    const ref = findProject(root, req.params.collection, req.params.project);
    const role = ref ? projectRole(root, auth, ref) : null;
    if (!ref || role === null) {
      apiError(res, 404, 'no such project');
      return null;
    }
    if (!atLeast(role, min)) {
      apiError(res, 403, `this takes the ${min} role on ${ref.collection}/${ref.name}`);
      return null;
    }
    let doc: LiveDoc;
    try {
      doc = docs.get(ref, String(req.query.path ?? ''));
    } catch (e) {
      if (e instanceof DocNotFound) {
        apiError(res, 404, e.message);
        return null;
      }
      throw e;
    }
    return { auth, ref, role, doc };
  }

  app.get('/api/whoami', (req, res) => {
    const auth = caller(req, res, false);
    if (!auth) return;
    res.json({ username: auth.username, siteAdmin: auth.user.siteAdmin === true });
  });

  const base = '/api/projects/:collection/:project';

  app.get(`${base}/doc`, (req, res) => {
    const a = access(req, res, 'read');
    if (!a) return;
    res.json({ epoch: a.doc.epoch, version: a.doc.version, doc: a.doc.text.toString(), writable: atLeast(a.role, 'write') });
  });

  app.post(`${base}/push`, json, (req, res) => {
    const a = access(req, res, 'write', true);
    if (!a) return;
    const { epoch, version, updates } = req.body ?? {};
    if (typeof epoch !== 'string' || !Number.isInteger(version) || !Array.isArray(updates)) {
      apiError(res, 400, 'epoch, version, and updates required');
      return;
    }
    try {
      res.json(a.doc.push(epoch, version, updates));
    } catch (e) {
      if (e instanceof PushRefused) apiError(res, 409, 'history moved on; reconnect');
      else apiError(res, 400, (e as Error).message);
    }
  });

  // Where someone's cursor is. Anyone who can read the file may say where
  // they are in it; the name shown is their username, never one they supply.
  app.post(`${base}/presence`, json, (req, res) => {
    const a = access(req, res, 'read', true);
    if (!a) return;
    const { epoch, version, clientID, anchor, head } = req.body ?? {};
    if (typeof epoch !== 'string' || !Number.isInteger(version) || typeof clientID !== 'string' || !Number.isInteger(anchor) || !Number.isInteger(head)) {
      apiError(res, 400, 'bad presence');
      return;
    }
    a.doc.presence(epoch, version, { clientID: clientID.slice(0, 40), name: a.auth.username, anchor, head });
    res.json({});
  });

  app.get(`${base}/events`, (req, res) => {
    const a = access(req, res, 'read');
    if (!a) return;
    const clientID = String(req.query.client ?? '').slice(0, 40);
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
    const unsubscribe = a.doc.subscribe({ clientID, send }, epoch, Number.isInteger(version) ? version : -1);
    const beat = setInterval(() => res.write(': beat\n\n'), HEARTBEAT_MS);
    req.on('close', close);
  });
}
