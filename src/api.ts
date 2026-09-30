import { Express, Request, Response } from 'express';
import { apiError, requireApiAuth } from '../../mochiforge/src/api/auth';
import { AuthLimiter } from '../../mochiforge/src/limit';
import {
  Role,
  addCollectionOwner,
  atLeast,
  canAdminCollection,
  canCreateCollection,
  canCreateRepo,
  collectionOwners,
  isCollectionOwner,
  removeCollaborator,
  removeCollectionOwner,
  repoAccess,
  setCollaborator,
} from '../../mochiforge/src/perms';
import { userExists } from '../../mochiforge/src/vault';
import { checkCsrf, getViewer } from '../../mochiforge/src/session';
import { AuthResult } from '../../mochiforge/src/vault';
import { DocNotFound, Docs } from './docs';
import { DocEvent, LiveDoc, PushRefused } from './livedoc';
import {
  ProjectError,
  ProjectRef,
  collectionExists,
  createCollection,
  createProject,
  deleteProject,
  findProject,
  listCollectionNames,
  listFiles,
  listProjectNames,
  projectDir,
  projectIsPrivate,
  projectMeta,
  projectRole,
} from './projects';

// The editor's JSON API; who the caller is, the users, and their tokens are
// mochi's routes (see src/server.ts). Every route here takes either of mochi's two credentials: a bearer
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

  const base = '/api/projects/:collection/:project';

  app.get(`${base}/doc`, (req, res) => {
    const a = access(req, res, 'read');
    if (!a) return;
    res.json({ epoch: a.doc.epoch, version: a.doc.version, doc: a.doc.text.toString(), writable: atLeast(a.role, 'write') });
  });

  app.post(`${base}/push`, (req, res) => {
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
  app.post(`${base}/presence`, (req, res) => {
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
    const unsubscribe = a.doc.subscribe({ clientID, send, end: close }, epoch, Number.isInteger(version) ? version : -1);
    const beat = setInterval(() => res.write(': beat\n\n'), HEARTBEAT_MS);
    req.on('close', close);
  });

  // ---- collections, projects, and collaborators, in the shapes of mochi's routes ----

  const body = (req: Request): Record<string, unknown> => (typeof req.body === 'object' && req.body !== null ? req.body : {});

  /** The projects in a collection the caller can open, by name. */
  const visible = (auth: AuthResult, collection: string): string[] =>
    listProjectNames(root, collection).filter(
      (p) => projectRole(root, auth, { collection, name: p, dir: projectDir(root, collection, p) }) !== null
    );

  app.get('/api/collections', (req, res) => {
    const auth = caller(req, res, false);
    if (!auth) return;
    res.json({
      collections: listCollectionNames(root).map((name) => ({ name, projectCount: visible(auth, name).length, owners: collectionOwners(root, name) })),
    });
  });

  app.get('/api/collections/:name', (req, res) => {
    const auth = caller(req, res, false);
    if (!auth) return;
    const { name } = req.params;
    if (!collectionExists(root, name)) {
      apiError(res, 404, `no collection ${name} on this shelf`);
      return;
    }
    res.json({ name, owners: collectionOwners(root, name), projects: visible(auth, name) });
  });

  app.post('/api/collections', (req, res) => {
    const auth = caller(req, res, true);
    if (!auth) return;
    const name = typeof body(req).name === 'string' ? (body(req).name as string) : '';
    if (!canCreateCollection(root, auth, name)) {
      apiError(res, 403, 'only a site admin can create a collection not named after you');
      return;
    }
    try {
      createCollection(root, name);
    } catch (e) {
      if (e instanceof ProjectError) {
        apiError(res, e.code === 'exists' ? 409 : 400, e.message);
        return;
      }
      throw e;
    }
    res.json({ name, created: true });
  });

  function ownersRoute(req: Request, res: Response, add: boolean): void {
    const auth = caller(req, res, true);
    if (!auth) return;
    const { name, user } = req.params;
    if (!collectionExists(root, name)) {
      apiError(res, 404, `no collection ${name} on this shelf`);
      return;
    }
    if (!canAdminCollection(root, auth, name)) {
      apiError(res, 403, `you are not an owner of ${name}`);
      return;
    }
    if (add) {
      if (!userExists(root, user)) {
        apiError(res, 404, `no user ${user} on this shelf`);
        return;
      }
      if (user === name) {
        res.json({ name, owners: collectionOwners(root, name), note: `${user} owns ${name} by name already` });
        return;
      }
      addCollectionOwner(root, name, user);
    } else {
      if (!collectionOwners(root, name).includes(user)) {
        apiError(res, 404, `${user} is not an explicit owner of ${name}`);
        return;
      }
      removeCollectionOwner(root, name, user);
    }
    res.json({ name, owners: collectionOwners(root, name) });
  }
  app.put('/api/collections/:name/owners/:user', (req, res) => ownersRoute(req, res, true));
  app.delete('/api/collections/:name/owners/:user', (req, res) => ownersRoute(req, res, false));

  const projectSummary = (auth: AuthResult, ref: ProjectRef) => ({
    collection: ref.collection,
    name: ref.name,
    description: projectMeta(ref).description,
    private: projectIsPrivate(ref),
    role: projectRole(root, auth, ref),
  });

  app.get('/api/projects', (req, res) => {
    const auth = caller(req, res, false);
    if (!auth) return;
    const projects = listCollectionNames(root).flatMap((c) =>
      visible(auth, c).map((p) => projectSummary(auth, { collection: c, name: p, dir: projectDir(root, c, p) }))
    );
    res.json({ projects });
  });

  app.post('/api/projects', (req, res) => {
    const auth = caller(req, res, true);
    if (!auth) return;
    const b = body(req);
    const collection = typeof b.collection === 'string' ? b.collection : '';
    const name = typeof b.name === 'string' ? b.name : '';
    const description = typeof b.description === 'string' ? b.description : '';
    const allowed = collectionExists(root, collection)
      ? canCreateRepo(root, auth, collection, name)
      : canCreateCollection(root, auth, collection);
    if (!allowed) {
      apiError(res, 403, `you may not create projects in ${collection}`);
      return;
    }
    try {
      const ref = createProject(root, collection, name, description);
      res.json({ ...projectSummary(auth, ref), created: true });
    } catch (e) {
      if (e instanceof ProjectError) {
        apiError(res, e.code === 'exists' ? 409 : 400, e.message);
        return;
      }
      throw e;
    }
  });

  /** The project named by the route and the caller's role there, which must be at least `min`. */
  function projectFor(req: Request, res: Response, min: Role, write: boolean): { auth: AuthResult; ref: ProjectRef } | null {
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
    return { auth, ref };
  }

  app.get('/api/projects/:collection/:project', (req, res) => {
    const p = projectFor(req, res, 'read', false);
    if (!p) return;
    res.json({
      ...projectSummary(p.auth, p.ref),
      files: listFiles(p.ref).map((f) => ({ path: f.path, size: f.size, text: f.text, modified: new Date(f.mtimeMs).toISOString() })),
    });
  });

  app.delete('/api/projects/:collection/:project', (req, res) => {
    const p = projectFor(req, res, 'admin', true);
    if (!p) return;
    const full = `${p.ref.collection}/${p.ref.name}`;
    if (String(req.query.confirm ?? '') !== full) {
      apiError(res, 400, `to delete this project and everything in it, send ?confirm=${full}`);
      return;
    }
    docs.dropProject(p.ref.dir);
    deleteProject(p.ref);
    res.json({ deleted: full });
  });

  const collaboratorList = (ref: ProjectRef) =>
    Object.entries(repoAccess(ref.dir).collaborators)
      .map(([username, role]) => ({ username, role }))
      .sort((a, b) => a.username.localeCompare(b.username));

  app.get('/api/projects/:collection/:project/collaborators', (req, res) => {
    const p = projectFor(req, res, 'read', false);
    if (!p) return;
    res.json({ collaborators: collaboratorList(p.ref), owners: collectionOwners(root, p.ref.collection) });
  });

  app.put('/api/projects/:collection/:project/collaborators/:user', (req, res) => {
    const p = projectFor(req, res, 'admin', true);
    if (!p) return;
    const role = body(req).role ?? 'write';
    if (role !== 'read' && role !== 'write' && role !== 'admin') {
      apiError(res, 400, '"role" must be read, write, or admin');
      return;
    }
    const user = req.params.user;
    if (!userExists(root, user)) {
      apiError(res, 404, `no user ${user} on this shelf`);
      return;
    }
    setCollaborator(p.ref.dir, user, role);
    const note = isCollectionOwner(root, p.ref.collection, user) ? `${user} owns ${p.ref.collection}, which already gives admin here` : undefined;
    res.json({ collaborators: collaboratorList(p.ref), ...(note ? { note } : {}) });
  });

  app.delete('/api/projects/:collection/:project/collaborators/:user', (req, res) => {
    const p = projectFor(req, res, 'admin', true);
    if (!p) return;
    if (repoAccess(p.ref.dir).collaborators[req.params.user] === undefined) {
      apiError(res, 404, `${req.params.user} is not a collaborator on ${p.ref.collection}/${p.ref.name}`);
      return;
    }
    removeCollaborator(p.ref.dir, req.params.user);
    res.json({ collaborators: collaboratorList(p.ref) });
  });
}
