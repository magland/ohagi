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

export function rawUrl(ref: { collection: string; name: string }, rel: string): string {
  return `${projectUrl(ref)}/raw/${encPath(rel)}`;
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
  const badge = p.isPrivate ? '' : html`<span class="counter" title="Anyone signed in can read this project">Public</span>`;
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
  canCreate: boolean,
  canAdmin = false
): string {
  const body =
    projects.length === 0
      ? html`<div class="empty-state">No projects here${viewer ? ' that you can see' : ''} yet.</div>`
      : projectGrid(projects, false);
  const newBtn = canCreate
    ? html`<a class="btn btn-primary" href="/new?collection=${esc(collection)}">${icon('plus')}<span>New project</span></a>`
    : '';
  const settingsBtn = canAdmin
    ? html`<a class="btn" href="${collectionUrl(collection)}/settings">${icon('sliders')}<span>Settings</span></a>`
    : '';
  const content = html`<div class="page-head"><h1 class="with-avatar">${avatar(collection, 28, 'square')}${collection}</h1><span class="right-group">${settingsBtn}${newBtn}</span></div>
${body}`;
  return page(collection, content, { crumbs: crumbs(collection), viewer, path: collectionUrl(collection) });
}

export function collectionSettingsPage(
  collection: string,
  owners: string[],
  projectCount: number,
  viewer: Viewer,
  opts: { msg?: string; error?: string } = {}
): string {
  const base = `${collectionUrl(collection)}/settings`;
  const rows = owners.map(
    (o) => html`<tr><td class="with-avatar">${userLink(o, { face: 24, bold: true })}</td><td class="right">
<form method="post" action="${base}/owners/remove" class="inline-form">
${csrfField(viewer)}
<input type="hidden" name="username" value="${o}">
<button type="submit" class="btn btn-danger-outline">Remove</button>
</form></td></tr>`
  );
  const danger =
    projectCount === 0
      ? html`<div class="danger-zone">
<h3>Danger zone</h3>
<p>The collection is empty, so deleting it removes only its directory and its list of owners.</p>
<form method="post" action="${base}/delete">
${csrfField(viewer)}
<div class="field"><label for="confirm">Type <b class="mono">${collection}</b> to confirm</label><input type="text" id="confirm" name="confirm" autocomplete="off"></div>
<button type="submit" class="btn btn-danger">${icon('trash')}<span>Delete this collection</span></button>
</form>
</div>`
      : html`<p class="muted small">A collection holding projects cannot be deleted; delete or move its projects first.</p>`;
  const content = html`<div class="page-head"><h1 class="with-avatar">${avatar(collection, 28, 'square')}${collection}</h1></div>
<h2>Settings</h2>
${flash(opts.msg)}
${formError(opts.error)}
<div class="box settings-box" id="owners"><div class="box-header">${icon('people')}Owners</div><div class="box-body">
<p>Owners hold the admin role on every project in <span class="mono">${collection}</span>, create projects in it, and manage it. The user named <b>${collection}</b>, if there is one, owns it without being listed.</p>
${rows.length ? html`<table class="listing"><tbody>${rows}</tbody></table>` : html`<p class="muted">No owners listed.</p>`}
<form method="post" action="${base}/owners" class="inline-form">
${csrfField(viewer)}
<label for="ownerUser">User</label><input type="text" id="ownerUser" name="username" required>
<button type="submit" class="btn">${icon('people')}<span>Add owner</span></button>
</form>
</div></div>
${danger}`;
  return page(`Settings - ${collection}`, content, { crumbs: crumbs(collection), viewer, path: base });
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

/** The project's tabs, as a repository's are under its title in a vault. */
function projectTabs(ref: ProjectRef, active: 'files' | 'settings', canSettings: boolean): Html {
  const tab = (id: string, label: string, href: string, glyph: 'file' | 'sliders') =>
    html`<a class="tab${active === id ? ' active' : ''}" href="${href}">${icon(glyph)}<span>${label}</span></a>`;
  return html`<nav class="tabs">
${tab('files', 'Files', projectUrl(ref), 'file')}
${canSettings ? tab('settings', 'Settings', `${projectUrl(ref)}/settings`, 'sliders') : ''}
</nav>`;
}

function projectTitle(ref: ProjectRef, isPrivate: boolean): Html {
  const badge = isPrivate
    ? html` <span class="counter" title="Only its members, its collection's owners, and site admins can see this project">Private</span>`
    : html` <span class="counter" title="Anyone signed in can read this project">Public</span>`;
  return html`<div class="repo-title">${icon('book')}<a href="${collectionUrl(ref.collection)}">${ref.collection}</a> <span class="muted">/</span> <a href="${projectUrl(
    ref
  )}"><b>${ref.name}</b></a>${badge}</div>`;
}

/** mochi's "Add file" menu: write one here, or upload some. */
function addFileMenu(ref: ProjectRef, dir: string): Html {
  const q = dir ? `?dir=${esc(dir)}` : '';
  return html`<details class="dropdown">
<summary class="btn">${icon('plus')}<span>Add file</span>${icon('chevron-down', 'caret')}</summary>
<div class="dropdown-menu dd-right">
<a class="dd-item" href="${projectUrl(ref)}/new${q}">${icon('file')}<span class="dd-label">Create new file</span></a>
<a class="dd-item" href="${projectUrl(ref)}/upload${q}">${icon('upload')}<span class="dd-label">Upload files</span></a>
</div>
</details>`;
}

export function projectPage(view: ProjectView, viewer: Viewer | null, baseUrl: string): string {
  const { ref } = view;
  const rows = view.files.map((f) => {
    const name = f.text
      ? html`${icon('file', 'icon file')}<a href="${fileUrl(ref, f.path)}">${f.path}</a>`
      : html`${icon('file', 'icon file')}<a href="${rawUrl(ref, f.path)}">${f.path}</a>`;
    const actions = view.canWrite
      ? html`<details class="dropdown file-actions"><summary class="btn" aria-label="Actions for ${f.path}">${icon('kebab')}</summary>
<div class="dropdown-menu dd-right">
<a class="dd-item" href="${projectUrl(ref)}/rename/${encPath(f.path)}">${icon('pencil')}<span class="dd-label">Rename or move</span></a>
<a class="dd-item" href="${rawUrl(ref, f.path)}?download=1">${icon('download')}<span class="dd-label">Download</span></a>
<a class="dd-item" href="${projectUrl(ref)}/delete/${encPath(f.path)}">${icon('trash')}<span class="dd-label">Delete</span></a>
</div></details>`
      : '';
    return html`<tr><td class="tree-name">${name}</td><td class="tree-message muted small">${f.text ? '' : 'binary'}</td><td class="right small muted">${formatSize(
      f.size
    )}</td><td class="tree-age right small">${timeTag(new Date(f.mtimeMs).toISOString())}</td><td class="right">${actions}</td></tr>`;
  });
  const main = view.files.find((f) => f.path === 'main.tex') ?? view.files.find((f) => f.text && f.path.endsWith('.tex'));
  const openBtn = main
    ? html`<a class="btn btn-primary" href="${fileUrl(ref, main.path)}">${icon('pencil')}<span>Open editor</span></a>`
    : '';
  const addBtn = view.canWrite ? addFileMenu(ref, '') : '';
  const members = view.members.length
    ? html`<ul class="member-list">${view.members.map(
        (m) => html`<li>${userLink(m.name, { face: 20 })}<span class="muted small">${m.role}</span></li>`
      )}</ul>`
    : html`<p class="muted small">Only site admins.</p>`;
  const description = view.meta.description
    ? html`<p class="side-desc">${view.meta.description}</p>`
    : html`<p class="side-desc muted">No description provided.</p>`;
  const clone = html`<div class="side-block"><h3>Clone</h3>${copyRow(`git clone ${baseUrl}${projectUrl(ref)}`)}<p class="muted small">Read-only: edits are made here, and a pull brings them. git asks for your username and a token; <span class="mono">ohagi login</span> stores one for it.</p></div>`;
  const content = html`${projectTitle(ref, view.isPrivate)}
${projectTabs(ref, 'files', view.canWrite)}
${flash(view.msg)}
<div class="toolbar"><div class="left"><span class="muted small">${view.files.length} file${view.files.length === 1 ? '' : 's'}</span></div><div class="right-group">${addBtn}${openBtn}</div></div>
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

// ---- adding, renaming, and removing files ----

function fileForm(ref: ProjectRef, viewer: Viewer, title: string, body: Html, path: string): string {
  const content = html`${projectTitle(ref, true)}
<div class="form-box wide">
<h1>${title}</h1>
${body}
</div>`;
  return page(`${title} - ${ref.collection}/${ref.name}`, content, { crumbs: crumbs(ref.collection, ref.name), viewer, path });
}

export function newFilePage(ref: ProjectRef, viewer: Viewer, preset: { path?: string }, error?: string): string {
  return fileForm(
    ref,
    viewer,
    'Create a new file',
    html`${formError(error)}
<form method="post" action="${projectUrl(ref)}/new">
${csrfField(viewer)}
<div class="field"><label for="path">Name</label><input type="text" id="path" name="path" value="${preset.path ?? ''}" placeholder="chapters/intro.tex" required autofocus>
<p class="muted small">A path within the project, with <span class="mono">/</span> between directories, which are created as needed. The file starts empty and opens in the editor.</p></div>
<div class="actions"><button type="submit" class="btn btn-primary">${icon('plus')}<span>Create file</span></button><a class="btn" href="${projectUrl(ref)}">Cancel</a></div>
</form>`,
    `${projectUrl(ref)}/new`
  );
}

export function uploadPage(ref: ProjectRef, viewer: Viewer, dir: string, maxBytes: number, error?: string): string {
  return fileForm(
    ref,
    viewer,
    'Upload files',
    html`${formError(error)}
<form method="post" action="${projectUrl(ref)}/upload" enctype="multipart/form-data">
<input type="hidden" name="csrf" value="${viewer.csrf}">
<div class="field"><label for="dir">Into directory</label><input type="text" id="dir" name="dir" value="${dir}" placeholder="(the top of the project)"></div>
<div class="field"><label for="files">Files</label><input type="file" id="files" name="files" multiple required>
<p class="muted small">Up to ${Math.floor(maxBytes / (1024 * 1024))} MB in all. A file that is already there is replaced; if someone has it open in the editor, their page takes the new text.</p></div>
<div class="actions"><button type="submit" class="btn btn-primary">${icon('upload')}<span>Upload</span></button><a class="btn" href="${projectUrl(ref)}">Cancel</a></div>
</form>`,
    `${projectUrl(ref)}/upload`
  );
}

export function renameFilePage(ref: ProjectRef, viewer: Viewer, from: string, preset: { to?: string }, error?: string): string {
  return fileForm(
    ref,
    viewer,
    `Rename ${from}`,
    html`${formError(error)}
<form method="post" action="${projectUrl(ref)}/rename/${encPath(from)}">
${csrfField(viewer)}
<div class="field"><label for="to">New name</label><input type="text" id="to" name="to" value="${preset.to ?? from}" required autofocus>
<p class="muted small">A path within the project; giving another directory moves the file there. Anyone editing it follows it to the new name.</p></div>
<div class="actions"><button type="submit" class="btn btn-primary">${icon('pencil')}<span>Rename</span></button><a class="btn" href="${projectUrl(ref)}">Cancel</a></div>
</form>`,
    `${projectUrl(ref)}/rename/${encPath(from)}`
  );
}

export function deleteFilePage(ref: ProjectRef, viewer: Viewer, rel: string, error?: string): string {
  return fileForm(
    ref,
    viewer,
    `Delete ${rel}`,
    html`${formError(error)}
<p>Deleting <span class="mono">${rel}</span> removes it and its editing history from the project. There is no undo.</p>
<form method="post" action="${projectUrl(ref)}/delete/${encPath(rel)}">
${csrfField(viewer)}
<div class="actions"><button type="submit" class="btn btn-danger">${icon('trash')}<span>Delete file</span></button><a class="btn" href="${projectUrl(ref)}">Cancel</a></div>
</form>`,
    `${projectUrl(ref)}/delete/${encPath(rel)}`
  );
}

// ---- a project's settings ----

export interface SettingsView {
  ref: ProjectRef;
  description: string;
  engine: string;
  isPrivate: boolean;
  canAdmin: boolean;
  collaborators: { username: string; role: string }[];
  owners: string[];
  msg?: string;
  error?: string;
}

export function projectSettingsPage(view: SettingsView, viewer: Viewer): string {
  const { ref } = view;
  const base = projectUrl(ref);
  const general = html`<div class="box settings-box" id="general"><div class="box-header">${icon('sliders')}General</div><div class="box-body">
<form method="post" action="${base}/settings">
${csrfField(viewer)}
<div class="field"><label for="description">Description</label><input type="text" id="description" name="description" value="${view.description}"><p class="muted small">Shown beside the project in listings and in its About panel.</p></div>
<div class="field"><label for="engine">Compiler</label><select id="engine" name="engine">${['pdflatex', 'xelatex', 'lualatex'].map(
    (e) => html`<option value="${e}"${e === view.engine ? raw(' selected') : ''}>${e}</option>`
  )}</select><p class="muted small">What latexmk runs. pdflatex suits most documents; xelatex and lualatex take system fonts and Unicode input directly.</p></div>
<button type="submit" class="btn btn-primary">${icon('check')}<span>Save</span></button>
</form>
</div></div>`;
  const collaboratorRows = view.collaborators.map(
    ({ username, role }) => html`<tr><td class="with-avatar">${userLink(username, { face: 24, bold: true })}</td><td class="muted">${role}</td><td class="right">
<form method="post" action="${base}/settings/collaborators/remove" class="inline-form">
${csrfField(viewer)}
<input type="hidden" name="username" value="${username}">
<button type="submit" class="btn btn-danger-outline">Remove</button>
</form></td></tr>`
  );
  const ownersNote = view.owners.length
    ? html`<p class="muted small">Owners of <span class="mono">${ref.collection}</span> (${joinHtml(
        view.owners.map((o) => html`<b>${o}</b>`),
        ', '
      )}, and the user the collection is named after) hold the admin role here without being listed.</p>`
    : html`<p class="muted small">The user the collection is named after, and any owners added to it, hold the admin role here without being listed.</p>`;
  const access = view.canAdmin
    ? html`<div class="box settings-box" id="access"><div class="box-header">${icon('people')}Access</div><div class="box-body">
<form method="post" action="${base}/settings/visibility">
${csrfField(viewer)}
<input type="hidden" name="private" value="${view.isPrivate ? 'false' : 'true'}">
<p>${
        view.isPrivate
          ? html`This project is <b>private</b>: seen by its collaborators, the collection's owners, and site admins, and by nobody else.`
          : html`This project is <b>public</b>: anyone signed in to this shelf can read it. Only its collaborators and owners can change it.`
      }</p>
<button type="submit" class="btn">${view.isPrivate ? 'Make public' : 'Make private'}</button>
</form>
<hr class="rule">
<h3>Collaborators</h3>
${
        collaboratorRows.length
          ? html`<table class="listing"><tbody><tr><th>User</th><th>Role</th><th class="right"></th></tr>${collaboratorRows}</tbody></table>`
          : html`<p class="muted">No collaborators.</p>`
      }
${ownersNote}
<form method="post" action="${base}/settings/collaborators" class="inline-form">
${csrfField(viewer)}
<label for="collabUser">User</label><input type="text" id="collabUser" name="username" required>
<label for="collabRole">Role</label><select id="collabRole" name="role">
<option value="read">read</option>
<option value="write" selected>write</option>
<option value="admin">admin</option>
</select>
<button type="submit" class="btn">${icon('people')}<span>Add</span></button>
</form>
<p class="muted small">read may open the project and follow along; write may also edit its files; admin may also change its settings and who is on it.</p>
</div></div>`
    : '';
  const rename = view.canAdmin
    ? html`<div class="danger-zone caution">
<h3>Rename or move</h3>
<p>Everything moves with the project: its files, its history, and who is on it. Anyone with one of its files open follows it to the new address. Old links stop working.</p>
<form method="post" action="${base}/settings/rename" class="inline-form">
${csrfField(viewer)}
<label for="toCollection">Collection</label><input type="text" id="toCollection" name="collection" value="${ref.collection}" required>
<label for="toName">Name</label><input type="text" id="toName" name="name" value="${ref.name}" required>
<button type="submit" class="btn">${icon('pencil')}<span>Rename</span></button>
</form>
<p class="muted small">The collection may be one you own, or the one named after you, which is created along with the move.</p>
</div>`
    : '';
  const danger = view.canAdmin
    ? html`<div class="danger-zone">
<h3>Danger zone</h3>
<p>Deleting a project removes its directory from the shelf permanently, files and history alike. There is no undo.</p>
<form method="post" action="${base}/settings/delete">
${csrfField(viewer)}
<div class="field"><label for="confirm">Type <b class="mono">${ref.collection}/${ref.name}</b> to confirm</label><input type="text" id="confirm" name="confirm" autocomplete="off"></div>
<button type="submit" class="btn btn-danger">${icon('trash')}<span>Delete this project</span></button>
</form>
</div>`
    : '';
  const content = html`${projectTitle(ref, view.isPrivate)}
${projectTabs(ref, 'settings', true)}
<h2>Settings</h2>
${flash(view.msg)}
${formError(view.error)}
${general}
${access}
${rename}
${danger}`;
  return page(`Settings - ${ref.collection}/${ref.name}`, content, { crumbs: crumbs(ref.collection, ref.name), viewer, path: `${base}/settings` });
}

// ---- the editor ----

export interface EditorView {
  ref: ProjectRef;
  path: string;
  files: ProjectFile[];
  canWrite: boolean;
  isPrivate: boolean;
}

export function editorPage(view: EditorView, viewer: Viewer, editorTag: string, workerTag: string): string {
  const { ref } = view;
  const fileRows = view.files.map((f) => {
    const current = f.path === view.path;
    const label = html`${icon('file', 'icon file')}<span>${f.path}</span>`;
    return f.text
      ? html`<li><a class="${current ? 'current' : ''}" href="${fileUrl(ref, f.path)}"${
          current ? raw(' aria-current="page"') : ''
        }>${label}</a></li>`
      : html`<li><a class="muted" href="${rawUrl(ref, f.path)}" target="_blank" rel="noopener">${label}</a></li>`;
  });
  const readOnly = view.canWrite ? '' : html`<span class="counter" title="You can read this project but not change it">Read only</span>`;
  const content = html`<div class="editor-head">
${projectTitle(ref, view.isPrivate)}
<span class="editor-file mono">${view.path}</span>${readOnly}
<span id="peers" class="editor-peers"></span><span id="status" class="editor-status">Connecting</span>
</div>
<div class="editor-body">
<nav class="editor-files" aria-label="Files">${
    view.canWrite
      ? html`<div class="editor-files-actions"><a href="${projectUrl(ref)}/new" title="Create a new file">${icon('plus')}<span>New</span></a><a href="${projectUrl(
          ref
        )}/upload" title="Upload files">${icon('upload')}<span>Upload</span></a></div>`
      : ''
  }<ul>${fileRows}</ul></nav>
<div id="editor" class="editor-pane" data-collection="${ref.collection}" data-project="${ref.name}" data-path="${view.path}" data-user="${
    viewer.auth.username
  }" data-csrf="${viewer.csrf}" data-writable="${view.canWrite ? '1' : ''}" data-pdf-worker="/assets/pdf.worker.mjs?v=${workerTag}"></div>
<section class="pdf-pane" aria-label="PDF">
<div class="pdf-bar">
<button type="button" class="btn btn-primary" id="recompile" title="Recompile (Ctrl+S or Ctrl+Enter)">${icon('play')}<span>Recompile</span></button>
<label class="auto-compile small" title="Compile a moment after typing stops"><input type="checkbox" id="auto-compile"> Auto</label>
<span id="compile-status" class="muted small"></span>
<button type="button" class="btn" id="show-issues" hidden></button>
<a class="btn" id="pdf-download" href="/api/projects/${ref.collection}/${ref.name}/output.pdf?download=1" hidden>${icon('download')}<span>PDF</span></a>
</div>
<div class="pdf-issues" id="issues" hidden></div>
<div class="pdf-pages" id="pdf-pages" hidden></div>
<div class="pdf-empty muted" id="pdf-empty">Press Recompile to see the PDF.</div>
</section>
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
