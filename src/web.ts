import { Express, Request, Response } from 'express';
import { collectionOwners, canCreateCollection, canCreateRepo, repoAccess } from '../../mochiforge/src/perms';
import { Viewer, getViewer } from '../../mochiforge/src/session';
import { field, requireViewerPage, requireViewerPost, urlencodedForm } from '../../mochiforge/src/web';
import { Docs } from './docs';
import {
  ProjectError,
  ProjectRef,
  cleanPath,
  collectionExists,
  createCollection,
  createProject,
  findProject,
  isEditableText,
  listCollectionNames,
  listFiles,
  listProjectNames,
  projectDir,
  projectIsPrivate,
  projectMeta,
  projectRole,
  projectUpdated,
  canWrite,
  filesDir,
} from './projects';
import * as views from './views';
import * as path from 'path';
import * as fs from 'fs';

// The shelf's pages. The sign-in and account pages are mochi's own and are
// registered beside these (see src/server.ts); everything here is what a
// shelf has and a vault does not.

const form = urlencodedForm('64kb');

export function registerWeb(app: Express, root: string, docs: Docs, editorTag: string): void {
  void docs;

  const notFound = (res: Response, viewer: Viewer | null, message = 'Not found') =>
    res.status(404).type('html').send(views.errorPage(404, message, { viewer }));

  /** The projects in a collection this viewer can open, as cards. */
  function cards(viewer: Viewer | null, collection: string): views.ProjectCard[] {
    const out: views.ProjectCard[] = [];
    for (const p of listProjectNames(root, collection)) {
      const ref = { collection, name: p, dir: projectDir(root, collection, p) };
      if (projectRole(root, viewer?.auth ?? null, ref) === null) continue;
      out.push({
        collection,
        name: p,
        description: projectMeta(ref).description,
        isPrivate: projectIsPrivate(ref),
        updated: projectUpdated(ref),
      });
    }
    return out;
  }

  app.get('/', (req, res) => {
    const viewer = getViewer(req, root);
    const collections = listCollectionNames(root).map((name) => ({ name, cards: cards(viewer, name) }));
    // A collection shows on the front page when the viewer can see something
    // in it, or it is theirs; an empty stranger's collection is not news.
    const shown = collections.filter(
      (c) => c.cards.length > 0 || (viewer && (viewer.auth.username === c.name || collectionOwners(root, c.name).includes(viewer.auth.username)))
    );
    res.type('html').send(
      views.homePage(
        root,
        shown.map((c) => ({ name: c.name, count: c.cards.length })),
        shown.flatMap((c) => c.cards),
        viewer
      )
    );
  });

  app.get('/about', (req, res) => {
    res.type('html').send(views.aboutPage(getViewer(req, root)));
  });

  // ---- creating ----

  app.get('/new', (req, res) => {
    const viewer = requireViewerPage(root, req, res);
    if (!viewer) return;
    const asked = typeof req.query.collection === 'string' ? req.query.collection : undefined;
    res.type('html').send(views.newProjectPage(viewer, ownedCollections(viewer), { collection: asked }));
  });

  /** The collections this viewer may create projects in, for the form's suggestions. */
  function ownedCollections(viewer: Viewer): string[] {
    return listCollectionNames(root).filter((c) => canCreateRepo(root, viewer.auth, c, 'x'));
  }

  app.post('/new', form, (req, res) => {
    const viewer = requireViewerPost(root, req, res);
    if (!viewer) return;
    const collection = field(req, 'collection').trim();
    const name = field(req, 'name').trim();
    const description = field(req, 'description');
    const rerender = (status: number, error: string) =>
      res.status(status).type('html').send(views.newProjectPage(viewer, ownedCollections(viewer), { collection, name, description }, error));
    // mochi's rules: owners create in their collections, site admins anywhere,
    // and a collection that does not exist yet may be created by whoever may
    // create it, which for anyone but a site admin is their own.
    if (!collectionExists(root, collection)) {
      if (!canCreateCollection(root, viewer.auth, collection)) {
        rerender(403, `There is no collection ${collection}, and only a site admin may create one not named after you.`);
        return;
      }
    } else if (!canCreateRepo(root, viewer.auth, collection, name)) {
      rerender(403, `You may not create projects in ${collection}.`);
      return;
    }
    try {
      const ref = createProject(root, collection, name, description);
      res.redirect(303, views.projectUrl(ref));
    } catch (e) {
      if (e instanceof ProjectError) rerender(e.code === 'exists' ? 409 : 400, e.message);
      else throw e;
    }
  });

  app.get('/new/collection', (req, res) => {
    const viewer = requireViewerPage(root, req, res);
    if (!viewer) return;
    res.type('html').send(views.newCollectionPage(viewer, {}));
  });

  app.post('/new/collection', form, (req, res) => {
    const viewer = requireViewerPost(root, req, res);
    if (!viewer) return;
    const name = field(req, 'name').trim();
    const rerender = (status: number, error: string) =>
      res.status(status).type('html').send(views.newCollectionPage(viewer, { name }, error));
    if (!canCreateCollection(root, viewer.auth, name)) {
      rerender(403, 'A collection not named after you takes a site admin to create.');
      return;
    }
    try {
      createCollection(root, name);
      res.redirect(303, views.collectionUrl(name));
    } catch (e) {
      if (e instanceof ProjectError) rerender(e.code === 'exists' ? 409 : 400, e.message);
      else throw e;
    }
  });

  // ---- a collection, a project, a file ----

  app.get('/:collection', (req, res) => {
    const viewer = getViewer(req, root);
    const { collection } = req.params;
    if (!collectionExists(root, collection)) return notFound(res, viewer, `Collection ${collection} not found`);
    const canCreate = viewer ? canCreateRepo(root, viewer.auth, collection, 'x') : false;
    res.type('html').send(views.collectionPage(collection, cards(viewer, collection), viewer, canCreate));
  });

  /**
   * The project named by the route, for a viewer who may read it. Someone not
   * signed in is sent to sign in, whatever the name, which says nothing about
   * whether it exists; someone signed in who cannot see it gets the 404 an
   * absent project gets, as a private repository does in a vault.
   */
  function loadProject(req: Request, res: Response): { viewer: Viewer; ref: ProjectRef; writable: boolean } | null {
    const viewer = requireViewerPage(root, req, res);
    if (!viewer) return null;
    const ref = findProject(root, req.params.collection, req.params.project);
    const role = ref ? projectRole(root, viewer.auth, ref) : null;
    if (!ref || role === null) {
      notFound(res, viewer, `Project ${req.params.collection}/${req.params.project} not found`);
      return null;
    }
    return { viewer, ref, writable: canWrite(role) };
  }

  function members(ref: ProjectRef): { name: string; role: string }[] {
    const out = new Map<string, string>();
    out.set(ref.collection, 'owner');
    for (const o of collectionOwners(root, ref.collection)) out.set(o, 'owner');
    for (const [u, role] of Object.entries(repoAccess(ref.dir).collaborators)) if (!out.has(u)) out.set(u, role);
    // The implicit owner is listed only when a user by that name exists; a
    // collection named for nobody has no implicit owner to show.
    return [...out.entries()].map(([name, role]) => ({ name, role }));
  }

  app.get('/:collection/:project', (req, res) => {
    const p = loadProject(req, res);
    if (!p) return;
    const msg = typeof req.query.msg === 'string' ? req.query.msg : undefined;
    res.type('html').send(
      views.projectPage(
        {
          ref: p.ref,
          meta: projectMeta(p.ref),
          files: listFiles(p.ref),
          isPrivate: projectIsPrivate(p.ref),
          canWrite: p.writable,
          members: members(p.ref),
          msg,
        },
        p.viewer,
        `${req.protocol}://${req.get('host')}`
      )
    );
  });

  app.get('/:collection/:project/edit/*', (req, res) => {
    const p = loadProject(req, res);
    if (!p) return;
    const rel = cleanPath((req.params as unknown as Record<string, string>)[0] ?? '');
    const file = rel ? path.join(filesDir(p.ref.dir), rel) : null;
    let ok = false;
    try {
      ok = !!file && fs.statSync(file).isFile() && isEditableText(file, fs.statSync(file).size);
    } catch {
      ok = false;
    }
    if (!rel || !ok) return notFound(res, p.viewer, 'No such text file in this project');
    res.type('html').send(
      views.editorPage(
        { ref: p.ref, path: rel, files: listFiles(p.ref), canWrite: p.writable, isPrivate: projectIsPrivate(p.ref) },
        p.viewer,
        editorTag
      )
    );
  });
}
