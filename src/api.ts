import express, { Express, Request, Response } from 'express';
import * as fs from 'fs';
import { statSync } from 'fs';

const fsStatFile = (f: string) => statSync(f).isFile();
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
import { Compiler, pdfPath, synctexEdit } from './compile';
import { DocNotFound, Docs } from './docs';
import { History } from './history';
import { DocEvent, LiveDoc, PushRefused } from './livedoc';
import { fileUrl } from './views';
import { projectRecordings } from './recording';
import {
  ProjectError,
  ProjectRef,
  collectionExists,
  createCollection,
  createProject,
  MAX_FILE_BYTES,
  deleteProject,
  fileExists,
  findProject,
  readFile,
  removeFile,
  renameFile,
  writeFile,
  cleanPath,
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

export function registerApi(app: Express, root: string, limiter: AuthLimiter, docs: Docs, compiler: Compiler, history: History): void {

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
    res.json({
      epoch: a.doc.epoch,
      version: a.doc.version,
      doc: a.doc.text.toString(),
      writable: atLeast(a.role, 'write'),
      recording: a.doc.recording !== null,
    });
  });

  app.post(`${base}/push`, (req, res) => {
    const a = access(req, res, 'write', true);
    if (!a) return;
    const { epoch, version, updates, sentAt } = req.body ?? {};
    if (typeof epoch !== 'string' || !Number.isInteger(version) || !Array.isArray(updates)) {
      apiError(res, 400, 'epoch, version, and updates required');
      return;
    }
    try {
      const result = a.doc.push(epoch, version, updates, {
        author: a.auth.username,
        sentAt: typeof sentAt === 'number' && Number.isFinite(sentAt) ? sentAt : undefined,
      });
      if (result.accepted && updates.length) history.touched(a.ref, a.auth.username, updates.length);
      res.json(result);
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

  // A copy made in a page of a recorded file: the server notes which
  // characters were copied (by their position in the text at the page's
  // version), under the nonce the page put on the clipboard, so that a paste
  // of them, in this file or another of the project, can say where they came
  // from. Nothing is stored but the characters' ids (see src/recording.ts).
  app.post(`${base}/awh/copy`, (req, res) => {
    const a = access(req, res, 'read', true);
    if (!a) return;
    const { epoch, version, nonce, ranges } = req.body ?? {};
    const rec = a.doc.recording;
    if (
      !rec ||
      epoch !== a.doc.epoch ||
      !Number.isInteger(version) ||
      version < a.doc.base ||
      version > a.doc.version ||
      typeof nonce !== 'string' ||
      !nonce ||
      nonce.length > 100 ||
      !Array.isArray(ranges) ||
      ranges.length > 1000
    ) {
      res.json({ registered: false });
      return;
    }
    // Carry the positions from the page's version to the current one.
    const later = a.doc.updates.slice(version - a.doc.base);
    const len = a.doc.text.length;
    const now: { from: number; to: number }[] = [];
    for (const r of ranges) {
      if (!Array.isArray(r) || !Number.isInteger(r[0]) || !Number.isInteger(r[1]) || r[0] < 0 || r[1] < r[0]) continue;
      let [from, to] = r as [number, number];
      for (const u of later) {
        from = u.changes.mapPos(from, 1);
        to = u.changes.mapPos(to, -1);
      }
      from = Math.min(from, len);
      to = Math.min(to, len);
      if (to > from) now.push({ from, to });
    }
    if (now.length) rec.copied(a.doc.text, now, nonce);
    res.json({ registered: now.length > 0 });
  });

  // Everything the who-wrote-what page shows for a file (see src/views.ts,
  // recordPage): its text, its recordings, and the other files' recordings
  // in the project, which text may have been moved or copied from.
  app.get(`${base}/awh/record`, async (req, res, next) => {
    try {
      const a = access(req, res, 'read');
      if (!a) return;
      docs.flushProject(a.ref.dir);
      await docs.settle(a.ref.dir);
      const clean = cleanPath(String(req.query.path ?? ''))!;
      const read = (f: string) => {
        try {
          return fs.readFileSync(f, 'utf8');
        } catch {
          return '';
        }
      };
      const all = projectRecordings(a.ref);
      res.json({
        title: clean.split('/').pop(),
        text: a.doc.text.toString(),
        recs: all.filter((r) => r.file === clean).map((r) => ({ name: r.workspace, log: read(r.full) })),
        others: all.filter((r) => r.file !== clean).map((r) => ({ name: `${r.file} · ${r.workspace}`, log: read(r.full) })),
      });
    } catch (e) {
      next(e);
    }
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
    history.forget(p.ref.dir);
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

  // ---- a project's files, as bytes ----

  const sendProjectError = (res: Response, e: unknown): void => {
    if (!(e instanceof ProjectError)) throw e;
    apiError(res, e.code === 'missing' ? 404 : e.code === 'exists' ? 409 : 400, e.message);
  };
  const pathParam = (req: Request) => String(req.query.path ?? '');

  app.get('/api/projects/:collection/:project/raw', (req, res) => {
    const p = projectFor(req, res, 'read', false);
    if (!p) return;
    try {
      res.type('application/octet-stream').send(readFile(p.ref, pathParam(req)));
    } catch (e) {
      sendProjectError(res, e);
    }
  });

  // The body is the file's bytes, whatever their type; ?overwrite=1 replaces
  // a file that exists, and someone editing it takes its new text.
  app.put('/api/projects/:collection/:project/raw', express.raw({ type: () => true, limit: MAX_FILE_BYTES }), (req, res) => {
    const p = projectFor(req, res, 'write', true);
    if (!p) return;
    const data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    try {
      const clean = writeFile(p.ref, pathParam(req), data, { overwrite: req.query.overwrite === '1' });
      docs.peek(p.ref, clean)?.reloadFromDisk(p.auth.username);
      history.touched(p.ref, p.auth.username);
      res.json({ path: clean, size: data.length });
    } catch (e) {
      sendProjectError(res, e);
    }
  });

  app.delete('/api/projects/:collection/:project/raw', async (req, res, next) => {
    const p = projectFor(req, res, 'write', true);
    if (!p) return;
    try {
      if (!fileExists(p.ref, pathParam(req))) throw new ProjectError(`There is no file ${pathParam(req)}.`, 'missing');
      await docs.closeFile(p.ref, pathParam(req), { type: 'closed', reason: 'deleted' });
      const gone = removeFile(p.ref, pathParam(req));
      history.touched(p.ref, p.auth.username);
      res.json({ deleted: gone });
    } catch (e) {
      if (e instanceof ProjectError) sendProjectError(res, e);
      else next(e);
    }
  });

  app.post('/api/projects/:collection/:project/rename', async (req, res, next) => {
    const p = projectFor(req, res, 'write', true);
    if (!p) return;
    const from = typeof body(req).from === 'string' ? (body(req).from as string) : '';
    const to = typeof body(req).to === 'string' ? (body(req).to as string) : '';
    try {
      if (!fileExists(p.ref, from)) throw new ProjectError(`There is no file ${from}.`, 'missing');
      const dest = cleanPath(to);
      if (!dest) throw new ProjectError(`Not a usable file name: ${to || '(empty)'}.`);
      if (dest !== from && fileExists(p.ref, dest)) throw new ProjectError(`${dest} already exists.`, 'exists');
      await docs.closeFile(p.ref, from, { type: 'closed', reason: 'moved', to: fileUrl(p.ref, dest) });
      const moved = renameFile(p.ref, from, dest);
      history.touched(p.ref, p.auth.username);
      res.json(moved);
    } catch (e) {
      if (e instanceof ProjectError) sendProjectError(res, e);
      else next(e);
    }
  });

  // ---- compiling ----
  //
  // Anyone who can read a project may compile it, as anyone who can see an
  // Overleaf project may press Recompile: it changes nothing in the project,
  // and the PDF is what a reader came for. Open files are written first, so
  // the compile sees what the editors show.

  app.post('/api/projects/:collection/:project/compile', async (req, res, next) => {
    const p = projectFor(req, res, 'read', true);
    if (!p) return;
    try {
      docs.flushProject(p.ref.dir);
      const result = await compiler.compile(p.ref, projectMeta(p.ref).engine ?? 'pdflatex');
      res.json(result);
    } catch (e) {
      next(e);
    }
  });

  app.get('/api/projects/:collection/:project/compile', (req, res) => {
    const p = projectFor(req, res, 'read', false);
    if (!p) return;
    const last = compiler.lastResult(p.ref);
    if (!last) {
      apiError(res, 404, 'this project has not been compiled yet');
      return;
    }
    res.json(last);
  });

  app.get('/api/projects/:collection/:project/output.pdf', (req, res) => {
    const p = projectFor(req, res, 'read', false);
    if (!p) return;
    const last = compiler.lastResult(p.ref);
    const file = last?.main ? pdfPath(p.ref, last.main) : null;
    if (!file || !fileExistsAbs(file)) {
      apiError(res, 404, 'there is no PDF yet; compile the project first');
      return;
    }
    const name = `${p.ref.name}.pdf`;
    res
      .set('Content-Type', 'application/pdf')
      // The browser's PDF viewer draws this in a process of its own, not as a
      // page of ours, and will not draw it at all under object-src 'none' or
      // a sandbox; what the policy still has to say is who may frame it.
      .set('Content-Security-Policy', "frame-ancestors 'self'")
      .set('Content-Disposition', `${req.query.download === '1' ? 'attachment' : 'inline'}; filename="${name}"`)
      .set('Cache-Control', 'private, no-cache')
      .sendFile(file);
  });

  // Where a point on the PDF came from, for a double-click in the PDF pane:
  // ?page=&x=&y=, in PDF points from the page's top left.
  app.get('/api/projects/:collection/:project/synctex', async (req, res, next) => {
    const p = projectFor(req, res, 'read', false);
    if (!p) return;
    const page = Number(req.query.page);
    const x = Number(req.query.x);
    const y = Number(req.query.y);
    if (!Number.isInteger(page) || page < 1 || !Number.isFinite(x) || !Number.isFinite(y)) {
      apiError(res, 400, 'page, x, and y required');
      return;
    }
    const last = compiler.lastResult(p.ref);
    if (!last?.main) {
      apiError(res, 404, 'this project has not been compiled yet');
      return;
    }
    try {
      const spot = await synctexEdit(p.ref, compiler.sandbox, last.main, page, x, y);
      if (!spot) {
        apiError(res, 404, 'nothing in the project is there');
        return;
      }
      res.json(spot);
    } catch (e) {
      next(e);
    }
  });
}

function fileExistsAbs(file: string): boolean {
  try {
    return fsStatFile(file);
  } catch {
    return false;
  }
}