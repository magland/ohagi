import { avatar } from '../../mochiforge/src/avatar';
import { Html, html, joinHtml, raw } from '../../mochiforge/src/html';
import { icon } from '../../mochiforge/src/icons';
import { formatSize, timeTag } from '../../mochiforge/src/render';
import { Viewer, viewerIsAdmin } from '../../mochiforge/src/session';
import { copyRow, csrfField, encPath, errorPage as mochiErrorPage, layout, userLink } from '../../mochiforge/src/views';
import { ProjectFile, ProjectMeta, ProjectRef } from './projects';

// ohagi's pages, drawn in mochi's layout and with mochi's markup, so that the
// shelf looks and behaves like a vault: the same top bar, theme menu, account
// menu, jump box, cards, listings, and forms. What is ohagi's own is what a
// vault has no page for: a project, and the editor.

const esc = encodeURIComponent;

export function collectionUrl(collection: string): string {
  return `/${esc(collection)}`;
}

export function projectUrl(ref: { collection: string; name: string }): string {
  return `/${esc(ref.collection)}/${esc(ref.name)}`;
}

export function fileUrl(ref: { collection: string; name: string }, rel: string): string {
  return `${projectUrl(ref)}/edit/${encPath(rel)}`;
}

function crumbs(collection: string, project?: string): Html {
  return html` / <a href="${collectionUrl(collection)}">${collection}</a>${
    project ? html` / <a href="${projectUrl({ collection, name: project })}">${project}</a>` : ''
  }`;
}

function formError(error?: string): Html | '' {
  return error ? html`<div class="form-error">${error}</div>` : '';
}

function flash(msg?: string): Html | '' {
  return msg ? html`<div class="flash">${msg}</div>` : '';
}

export const page = layout;
export const errorPage = mochiErrorPage;

// ---- listings ----

export interface ProjectCard {
  collection: string;
  name: string;
  description: string;
  isPrivate: boolean;
  updated: string | null;
}

function projectCard(p: ProjectCard, showCollection: boolean): Html {
  const prefix = showCollection ? html`<span class="rc-collection">${p.collection}/</span>` : '';
  const desc = p.description ? html`<p class="rc-desc">${p.description}</p>` : '';
  const badge = p.isPrivate ? '' : html`<span class="counter" title="Anyone can read this project">Public</span>`;
  return html`<li class="repo-card">
<div class="rc-top"><a class="rc-name" href="${projectUrl(p)}">${prefix}${p.name}</a>${badge}</div>
${desc}
<div class="rc-meta">${p.updated ? html`<span class="rc-when">${timeTag(p.updated)}</span>` : ''}</div>
</li>`;
}

function projectGrid(projects: ProjectCard[], showCollection: boolean): Html {
  const sorted = [...projects].sort((a, b) => (b.updated ?? '').localeCompare(a.updated ?? ''));
  const filter =
    projects.length > 5
      ? html`<div class="listing-controls"><input class="list-filter" type="text" placeholder="Filter projects" data-target="repo-list" data-filter="cards" aria-label="Filter projects"></div>`
      : '';
  return html`${filter}<ul class="repo-grid" id="repo-list">${joinHtml(
    sorted.map((p) => projectCard(p, showCollection)),
    '\n'
  )}</ul><div class="empty-state" id="repo-list-empty" hidden>No match.</div>`;
}

export function homePage(
  rootLabel: string,
  collections: { name: string; count: number }[],
  projects: ProjectCard[],
  viewer: Viewer | null
): string {
  const chips = collections.length
    ? html`<nav class="collection-chips" aria-label="Collections">${collections.map(
        (c) =>
          html`<a class="coll-chip" href="${collectionUrl(c.name)}">${avatar(c.name, 18, 'square')}<span>${c.name}</span><span class="coll-count">${c.count}</span></a>`
      )}</nav>`
    : '';
  const body = !viewer
    ? html`<div class="empty-state">Projects on this shelf are seen by their members. <a href="/login?next=%2F">Sign in</a> to see yours.</div>`
    : projects.length === 0
      ? html`<div class="empty-state">No projects yet. Create one with the button above.</div>`
      : projectGrid(projects, true);
  const newBtn = viewer
    ? html`<a class="btn" href="/new/collection">${icon('plus')}<span>New collection</span></a><a class="btn btn-primary" href="/new">${icon(
        'plus'
      )}<span>New project</span></a>`
    : '';
  const summary =
    viewer && projects.length
      ? html`<p class="lede">${projects.length} ${projects.length === 1 ? 'project' : 'projects'} in ${collections.length} ${
          collections.length === 1 ? 'collection' : 'collections'
        }.</p>`
      : '';
  const content = html`<div class="page-head"><h1>Projects</h1><span class="right-group">${newBtn}</span></div>
${summary}
${chips}
${body}
${viewerIsAdmin(viewer) ? html`<p class="muted small vault-note">Serving ${rootLabel}</p>` : ''}`;
  return page('ohagi', content, { viewer, path: '/' });
}

export function collectionPage(
  collection: string,
  projects: ProjectCard[],
  viewer: Viewer | null,
  canCreate: boolean
): string {
  const body =
    projects.length === 0
      ? html`<div class="empty-state">No projects here${viewer ? ' that you can see' : ''} yet.</div>`
      : projectGrid(projects, false);
  const newBtn = canCreate
    ? html`<a class="btn btn-primary" href="/new?collection=${esc(collection)}">${icon('plus')}<span>New project</span></a>`
    : '';
  const content = html`<div class="page-head"><h1 class="with-avatar">${avatar(collection, 28, 'square')}${collection}</h1><span class="right-group">${newBtn}</span></div>
${body}`;
  return page(collection, content, { crumbs: crumbs(collection), viewer, path: collectionUrl(collection) });
}

// ---- a project ----

export interface ProjectView {
  ref: ProjectRef;
  meta: ProjectMeta;
  files: ProjectFile[];
  isPrivate: boolean;
  canWrite: boolean;
  /** Who can open it besides site admins: the collection's owners and the collaborators, with roles. */
  members: { name: string; role: string }[];
  msg?: string;
}

function projectTitle(ref: ProjectRef, isPrivate: boolean): Html {
  const badge = isPrivate
    ? html` <span class="counter" title="Only its members, its collection's owners, and site admins can see this project">Private</span>`
    : html` <span class="counter" title="Anyone can read this project">Public</span>`;
  return html`<div class="repo-title">${icon('book')}<a href="${collectionUrl(ref.collection)}">${ref.collection}</a> <span class="muted">/</span> <a href="${projectUrl(
    ref
  )}"><b>${ref.name}</b></a>${badge}</div>`;
}

export function projectPage(view: ProjectView, viewer: Viewer | null, baseUrl: string): string {
  const { ref } = view;
  const rows = view.files.map((f) => {
    const name = f.text
      ? html`${icon('file', 'icon file')}<a href="${fileUrl(ref, f.path)}">${f.path}</a>`
      : html`${icon('file', 'icon file')}<span>${f.path}</span>`;
    return html`<tr><td class="tree-name">${name}</td><td class="tree-message muted small">${f.text ? '' : 'binary'}</td><td class="right small muted">${formatSize(
      f.size
    )}</td><td class="tree-age right small">${timeTag(new Date(f.mtimeMs).toISOString())}</td></tr>`;
  });
  const main = view.files.find((f) => f.path === 'main.tex') ?? view.files.find((f) => f.text && f.path.endsWith('.tex'));
  const openBtn = main
    ? html`<a class="btn btn-primary" href="${fileUrl(ref, main.path)}">${icon('pencil')}<span>Open editor</span></a>`
    : '';
  const members = view.members.length
    ? html`<ul class="member-list">${view.members.map(
        (m) => html`<li>${userLink(m.name, { face: 20 })}<span class="muted small">${m.role}</span></li>`
      )}</ul>`
    : html`<p class="muted small">Only site admins.</p>`;
  const description = view.meta.description
    ? html`<p class="side-desc">${view.meta.description}</p>`
    : html`<p class="side-desc muted">No description provided.</p>`;
  const clone = html`<div class="side-block"><h3>Files on disk</h3><p class="muted small">This project's files are plain files in the shelf. Cloning them with git comes later.</p></div>`;
  void baseUrl;
  const content = html`${projectTitle(ref, view.isPrivate)}
${flash(view.msg)}
<div class="toolbar"><div class="left"><span class="muted small">${view.files.length} file${view.files.length === 1 ? '' : 's'}</span></div><div class="right-group">${openBtn}</div></div>
<div class="repo-layout">
<div class="repo-main">
<table class="listing tree"><tbody>${rows.length ? rows : raw('<tr><td class="muted">No files yet.</td></tr>')}</tbody></table>
</div>
<aside class="repo-side">
<div class="side-block"><h3>About</h3>${description}</div>
<div class="side-block"><h3>Members</h3>${members}</div>
${clone}
</aside>
</div>`;
  return page(`${ref.collection}/${ref.name}`, content, { crumbs: crumbs(ref.collection, ref.name), viewer, path: projectUrl(ref) });
}

// ---- the editor ----

export interface EditorView {
  ref: ProjectRef;
  path: string;
  files: ProjectFile[];
  canWrite: boolean;
  isPrivate: boolean;
}

export function editorPage(view: EditorView, viewer: Viewer, editorTag: string): string {
  const { ref } = view;
  const fileRows = view.files.map((f) => {
    const current = f.path === view.path;
    const label = html`${icon('file', 'icon file')}<span>${f.path}</span>`;
    return f.text
      ? html`<li><a class="${current ? 'current' : ''}" href="${fileUrl(ref, f.path)}"${
          current ? raw(' aria-current="page"') : ''
        }>${label}</a></li>`
      : html`<li><span class="muted">${label}</span></li>`;
  });
  const readOnly = view.canWrite ? '' : html`<span class="counter" title="You can read this project but not change it">Read only</span>`;
  const content = html`<div class="editor-head">
${projectTitle(ref, view.isPrivate)}
<span class="editor-file mono">${view.path}</span>${readOnly}
<span id="peers" class="editor-peers"></span><span id="status" class="editor-status">Connecting</span>
</div>
<div class="editor-body">
<nav class="editor-files" aria-label="Files"><ul>${fileRows}</ul></nav>
<div id="editor" class="editor-pane" data-collection="${ref.collection}" data-project="${ref.name}" data-path="${view.path}" data-user="${
    viewer.auth.username
  }" data-csrf="${viewer.csrf}" data-writable="${view.canWrite ? '1' : ''}"></div>
</div>`;
  return page(`${view.path} · ${ref.collection}/${ref.name}`, content, {
    crumbs: crumbs(ref.collection, ref.name),
    viewer,
    path: fileUrl(ref, view.path),
    bodyClass: 'ohagi-editor',
    head: html`\n<script src="/assets/editor.js?v=${editorTag}" defer></script>`,
  });
}

// ---- forms ----

export function newProjectPage(
  viewer: Viewer,
  collections: string[],
  preset: { collection?: string; name?: string; description?: string },
  error?: string
): string {
  const chosen = preset.collection ?? viewer.auth.username;
  const options = [...new Set([...collections, viewer.auth.username])].sort();
  const content = html`<div class="form-box wide">
<h1>Create a new project</h1>
<p class="muted">A project is a set of files edited together: a paper, a thesis, a proposal. It starts with a <span class="mono">main.tex</span> and is private to its members.</p>
<hr class="rule">
${formError(error)}
<form method="post" action="/new">
${csrfField(viewer)}
<div class="name-row">
  <div class="field"><label for="collection">Collection</label><input type="text" id="collection" name="collection" list="collections" value="${chosen}" required><datalist id="collections">${options.map(
    (c) => html`<option value="${c}">`
  )}</datalist></div>
  <div class="name-slash">/</div>
  <div class="field"><label for="name">Project name</label><input type="text" id="name" name="name" value="${
    preset.name ?? ''
  }" required autofocus></div>
</div>
<p class="muted small">Letters, digits, dot, underscore, and dash. The collection may be one you own or a new one named after you.</p>
<div class="field"><label for="description">Description <span class="muted">(optional)</span></label><input type="text" id="description" name="description" value="${
    preset.description ?? ''
  }"></div>
<button type="submit" class="btn btn-primary">${icon('plus')}<span>Create project</span></button>
</form>
</div>`;
  return page('New project', content, { viewer, path: '/new' });
}

export function newCollectionPage(viewer: Viewer, preset: { name?: string }, error?: string): string {
  const content = html`<div class="form-box wide">
<h1>Create a new collection</h1>
<p class="muted">A collection is a directory on the shelf holding projects, as a vault's holds repositories.</p>
<hr class="rule">
${formError(error)}
<form method="post" action="/new/collection">
${csrfField(viewer)}
<div class="field"><label for="name">Collection name</label><input type="text" id="name" name="name" value="${
    preset.name ?? ''
  }" required autofocus></div>
<p class="muted small">Letters, digits, dot, underscore, and dash. The collection named after you is yours to create; any other name takes a site admin.</p>
<button type="submit" class="btn btn-primary">${icon('plus')}<span>Create collection</span></button>
</form>
</div>`;
  return page('New collection', content, { viewer, path: '/new/collection' });
}

export function aboutPage(viewer: Viewer | null): string {
  const content = html`<div class="about-page">
<h1>About this shelf</h1>
<p class="lede">This site is a <i>shelf</i>: a small self-hosted LaTeX editor, holding projects grouped into collections, where several people can edit one file at once.</p>
<p>Projects are private to their members. Accounts are created by this shelf's administrator; there is no sign-up. Your token <a href="/login">signs you in</a> here, and the command line uses it too:</p>
${copyRow('npx @magland/ohagi login <this address>')}
<p>The software is <a href="https://github.com/magland/ohagi">ohagi</a>, built on <a href="https://github.com/magland/mochiforge">Mochi Forge</a>, open source under the Apache 2.0 license.</p>
</div>`;
  return page('About - ohagi', content, { viewer, path: '/about' });
}
