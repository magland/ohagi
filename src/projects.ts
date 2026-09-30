import * as fs from 'fs';
import * as path from 'path';
import { writeFileAtomic } from '../../mochiforge/src/atomic';
import { collectionDir, collectionsDir } from '../../mochiforge/src/layout';
import {
  Role,
  atLeast,
  collectionOwners,
  removeCollaborator,
  removeCollectionOwner,
  repoAccess,
  repoIsPrivate,
  repoRole,
  setRepoPrivate,
} from '../../mochiforge/src/perms';
import { isDotName, isValidName, isValidUserName } from '../../mochiforge/src/scan';
import { AuthResult } from '../../mochiforge/src/vault';

// A shelf holds collections of projects, laid out the way a mochi vault holds
// collections of repositories, and read with the same rules:
//
//   <shelf>/
//     shelf.json                  users and hashed tokens (mochi's vault.json)
//     config.json                 settings, mochi's shape: theme, limits, ...
//     collections/
//       alice/
//         collection.json         the collection's explicit owners (mochi's)
//         projects/
//           paper/
//             access.json         private flag and collaborators (mochi's
//                                 mochi.json, under ohagi's name)
//             project.json        description
//             files/              the project's files, and nothing else
//             collab/             per text file: <file>.json and <file>.log
//
// Everything about who may do what is mochi's (src/perms.ts there): a user
// owns the collection named after them, a collection may list further owners,
// a project lists collaborators with read, write, or admin roles, and a site
// admin holds admin everywhere. A project is created private, so that only
// its collaborators, its collection's owners, and site admins see it; that is
// what "members only" means here, and the same switch mochi has could make
// one readable by anyone signed in or not.

export const PROJECTS_DIR = 'projects';

export function projectsDir(root: string, collection: string): string {
  return path.join(collectionDir(root, collection), PROJECTS_DIR);
}

export function projectDir(root: string, collection: string, project: string): string {
  return path.join(projectsDir(root, collection), project);
}

export function filesDir(dir: string): string {
  return path.join(dir, 'files');
}

export function collabDir(dir: string): string {
  return path.join(dir, 'collab');
}

/** A project, as a permission question is asked about it: mochi's RepoRef. */
export interface ProjectRef {
  collection: string;
  name: string;
  dir: string;
}

export class ProjectError extends Error {
  constructor(
    message: string,
    readonly code: 'invalid' | 'exists' | 'missing' = 'invalid'
  ) {
    super(message);
  }
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function listCollectionNames(root: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(collectionsDir(root), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && isValidName(e.name) && !isDotName(e.name))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
}

export function collectionExists(root: string, collection: string): boolean {
  return isValidName(collection) && !isDotName(collection) && isDir(collectionDir(root, collection));
}

export function listProjectNames(root: string, collection: string): string[] {
  if (!collectionExists(root, collection)) return [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(projectsDir(root, collection), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && isValidName(e.name) && !isDotName(e.name))
    .filter((e) => isDir(filesDir(projectDir(root, collection, e.name))))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
}

export function findProject(root: string, collection: string, project: string): ProjectRef | null {
  if (!collectionExists(root, collection) || !isValidName(project) || isDotName(project)) return null;
  const dir = projectDir(root, collection, project);
  if (!isDir(filesDir(dir))) return null;
  return { collection, name: project, dir };
}

/** The viewer's role on the project, or null when they cannot see it; see mochi's repoRole. */
export function projectRole(root: string, auth: AuthResult | null, ref: ProjectRef): Role | null {
  return repoRole(root, auth, ref);
}

export function canWrite(role: Role | null): boolean {
  return atLeast(role, 'write');
}

export function projectIsPrivate(ref: ProjectRef): boolean {
  return repoIsPrivate(ref.dir);
}

// ---- project.json ----

export type Engine = 'pdflatex' | 'xelatex' | 'lualatex';

export interface ProjectMeta {
  description: string;
  created: string | null;
  /** The TeX engine latexmk runs; pdflatex unless the project says otherwise. */
  engine?: Engine;
}

export function projectMeta(ref: ProjectRef): ProjectMeta {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(ref.dir, 'project.json'), 'utf8')) as Record<string, unknown>;
    const engine = raw.engine === 'xelatex' || raw.engine === 'lualatex' ? raw.engine : undefined;
    return {
      description: typeof raw.description === 'string' ? raw.description : '',
      created: typeof raw.created === 'string' ? raw.created : null,
      ...(engine ? { engine } : {}),
    };
  } catch {
    return { description: '', created: null };
  }
}

export function setProjectMeta(ref: ProjectRef, meta: ProjectMeta): void {
  writeFileAtomic(path.join(ref.dir, 'project.json'), JSON.stringify(meta, null, 2) + '\n');
}

// ---- files ----

export interface ProjectFile {
  path: string;
  size: number;
  mtimeMs: number;
  /** Whether it opens in the editor: small, and text rather than binary. */
  text: boolean;
}

/** Files larger than this are not opened for editing. */
export const MAX_EDIT_BYTES = 4 * 1024 * 1024;

export function isEditableText(file: string, size: number): boolean {
  if (size > MAX_EDIT_BYTES) return false;
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(Math.min(size, 8192));
    fs.readSync(fd, buf, 0, buf.length, 0);
    if (buf.includes(0)) return false;
    try {
      // A character cut off at the end of the sample is not a reason to refuse.
      new TextDecoder('utf-8', { fatal: true }).decode(size > buf.length ? buf.subarray(0, buf.length - 4) : buf);
    } catch {
      return false;
    }
    return true;
  } finally {
    fs.closeSync(fd);
  }
}

/** Every file in the project, relative paths, sorted; dot-files and dot-directories are not part of a project. */
export function listFiles(ref: ProjectRef): ProjectFile[] {
  const root = filesDir(ref.dir);
  const out: ProjectFile[] = [];
  const walk = (dir: string, prefix: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of entries) {
      if (d.name.startsWith('.')) continue;
      const rel = prefix ? `${prefix}/${d.name}` : d.name;
      const full = path.join(dir, d.name);
      if (d.isDirectory()) walk(full, rel);
      else if (d.isFile()) {
        const st = fs.statSync(full);
        out.push({ path: rel, size: st.size, mtimeMs: st.mtimeMs, text: isEditableText(full, st.size) });
      }
    }
  };
  walk(root, '');
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** When anything in the project last changed, or null for an empty one. */
export function projectUpdated(ref: ProjectRef): string | null {
  let newest = 0;
  for (const f of listFiles(ref)) newest = Math.max(newest, f.mtimeMs);
  return newest ? new Date(newest).toISOString() : null;
}

/**
 * A project-relative path, checked: no absolute paths, nothing that climbs
 * out, no dot-segments at all (so neither a hidden file nor anything under a
 * future .git is ever served), forward slashes only.
 */
export function cleanPath(rel: string): string | null {
  if (typeof rel !== 'string' || !rel || rel.length > 500) return null;
  const parts = rel.split('/');
  if (parts.some((p) => !p || p.startsWith('.') || p.includes('\\') || p.includes('\0'))) return null;
  return parts.join('/');
}

// ---- creating ----

const TEMPLATE = `\\documentclass{article}
\\usepackage{amsmath}

\\title{Untitled}
\\author{}

\\begin{document}
\\maketitle

\\section{Introduction}

\\end{document}
`;

/**
 * A collection with nothing in it yet. The name follows mochi's rule for a
 * name being created: letters, digits, dot, underscore, and dash, no leading
 * dot, not one of the interface's own words, and not too long.
 */
export function createCollection(root: string, name: string): void {
  if (!isValidUserName(name)) throw new ProjectError('A collection name may use letters, digits, dot, underscore, and dash, and must not be a reserved word.');
  if (collectionExists(root, name)) throw new ProjectError(`Collection ${name} already exists.`, 'exists');
  fs.mkdirSync(projectsDir(root, name), { recursive: true });
}

/**
 * A new project, private, holding a main.tex to start from. The collection is
 * created on the way if it does not exist, as mochi creates one for a new
 * repository.
 */
export function createProject(root: string, collection: string, name: string, description = ''): ProjectRef {
  if (!isValidUserName(collection)) throw new ProjectError('That collection name is not allowed.');
  if (!isValidUserName(name)) throw new ProjectError('A project name may use letters, digits, dot, underscore, and dash, and must not be a reserved word.');
  const dir = projectDir(root, collection, name);
  if (fs.existsSync(dir)) throw new ProjectError(`Project ${collection}/${name} already exists.`, 'exists');
  fs.mkdirSync(filesDir(dir), { recursive: true });
  const ref = { collection, name, dir };
  setRepoPrivate(dir, true);
  setProjectMeta(ref, { description: description.trim().slice(0, 400), created: new Date().toISOString() });
  fs.writeFileSync(path.join(filesDir(dir), 'main.tex'), TEMPLATE);
  return ref;
}

/** Remove a project's directory, files and history alike. */
export function deleteProject(ref: ProjectRef): void {
  fs.rmSync(ref.dir, { recursive: true, force: true });
}

/**
 * Every grant naming a user, removed when the user is: their place among a
 * collection's owners and on every project's collaborators. A later user
 * given the same name inherits nothing. mochi's does the same over
 * repositories (removeUserGrants there).
 */
export function removeUserGrants(root: string, username: string): void {
  for (const collection of listCollectionNames(root)) {
    if (collectionOwners(root, collection).includes(username)) removeCollectionOwner(root, collection, username);
    for (const name of listProjectNames(root, collection)) {
      const dir = projectDir(root, collection, name);
      if (repoAccess(dir).collaborators[username] !== undefined) removeCollaborator(dir, username);
    }
  }
}

/** Remove an empty collection's directory (its owners list goes with it). */
export function deleteCollection(root: string, collection: string): void {
  if (listProjectNames(root, collection).length > 0) throw new ProjectError(`Collection ${collection} still holds projects.`, 'exists');
  fs.rmSync(collectionDir(root, collection), { recursive: true, force: true });
}

// ---- changing files ----
//
// Every path is a project-relative one checked by cleanPath, so nothing here
// reaches outside files/. Writing a file creates the directories above it,
// and removing one removes directories it leaves empty, so a project never
// holds an empty directory it did not ask for. Each file's editing state
// (collab/<path>.json and .log) moves and goes with it.

/** The largest file an upload or a write may bring. */
export const MAX_FILE_BYTES = 50 * 1024 * 1024;

/** Written beside and renamed over, so a reader never sees half a file. */
function writeBufferAtomic(file: string, data: Buffer): void {
  // A dot-name, so a listing of the project never shows it.
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.tmp-${process.pid}`);
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

function fileOf(ref: ProjectRef, rel: string): { clean: string; full: string } {
  const clean = cleanPath(rel);
  if (!clean) throw new ProjectError(`Not a usable file name: ${rel || '(empty)'}. Use letters, digits, and the usual punctuation, with / between directories, and no name starting with a dot.`);
  return { clean, full: path.join(filesDir(ref.dir), clean) };
}

function collabFiles(ref: ProjectRef, clean: string): string[] {
  return [path.join(collabDir(ref.dir), `${clean}.json`), path.join(collabDir(ref.dir), `${clean}.log`)];
}

/** A directory in the way of a file, or a file in the way of a directory, said in words. */
function checkPlace(ref: ProjectRef, clean: string): void {
  const parts = clean.split('/');
  let at = filesDir(ref.dir);
  for (let i = 0; i < parts.length - 1; i++) {
    at = path.join(at, parts[i]);
    if (fs.existsSync(at) && !fs.statSync(at).isDirectory()) {
      throw new ProjectError(`${parts.slice(0, i + 1).join('/')} is a file, so nothing can go inside it.`, 'exists');
    }
  }
  const full = path.join(filesDir(ref.dir), clean);
  if (fs.existsSync(full) && fs.statSync(full).isDirectory()) throw new ProjectError(`${clean} is a directory.`, 'exists');
}

export function fileExists(ref: ProjectRef, rel: string): boolean {
  const clean = cleanPath(rel);
  if (!clean) return false;
  try {
    return fs.statSync(path.join(filesDir(ref.dir), clean)).isFile();
  } catch {
    return false;
  }
}

/** Write a file, creating it; replacing one that exists only when asked to. Returns its clean path. */
export function writeFile(ref: ProjectRef, rel: string, data: Buffer, opts: { overwrite: boolean }): string {
  const { clean, full } = fileOf(ref, rel);
  if (data.length > MAX_FILE_BYTES) throw new ProjectError(`${clean} is larger than ${MAX_FILE_BYTES / (1024 * 1024)} MB.`);
  checkPlace(ref, clean);
  if (!opts.overwrite && fs.existsSync(full)) throw new ProjectError(`${clean} already exists.`, 'exists');
  fs.mkdirSync(path.dirname(full), { recursive: true });
  writeBufferAtomic(full, data);
  return clean;
}

export function readFile(ref: ProjectRef, rel: string): Buffer {
  const { clean, full } = fileOf(ref, rel);
  if (!fileExists(ref, clean)) throw new ProjectError(`There is no file ${clean}.`, 'missing');
  return fs.readFileSync(full);
}

/** Remove directories under files/ (and collab/) that a move or a removal left empty. */
function pruneEmpty(base: string, clean: string): void {
  let dir = path.dirname(path.join(base, clean));
  while (dir.startsWith(base + path.sep)) {
    try {
      fs.rmdirSync(dir);
    } catch {
      return;
    }
    dir = path.dirname(dir);
  }
}

/** Move a file, and its editing history with it. The caller has written and closed any open editor first. */
export function renameFile(ref: ProjectRef, from: string, to: string): { from: string; to: string } {
  const a = fileOf(ref, from);
  const b = fileOf(ref, to);
  if (!fileExists(ref, a.clean)) throw new ProjectError(`There is no file ${a.clean}.`, 'missing');
  if (a.clean === b.clean) return { from: a.clean, to: b.clean };
  checkPlace(ref, b.clean);
  if (fs.existsSync(b.full)) throw new ProjectError(`${b.clean} already exists.`, 'exists');
  fs.mkdirSync(path.dirname(b.full), { recursive: true });
  fs.renameSync(a.full, b.full);
  const [fromMeta, fromLog] = collabFiles(ref, a.clean);
  const [toMeta, toLog] = collabFiles(ref, b.clean);
  for (const [x, y] of [
    [fromMeta, toMeta],
    [fromLog, toLog],
  ]) {
    if (fs.existsSync(x)) {
      fs.mkdirSync(path.dirname(y), { recursive: true });
      fs.renameSync(x, y);
    }
  }
  pruneEmpty(filesDir(ref.dir), a.clean);
  pruneEmpty(collabDir(ref.dir), a.clean);
  return { from: a.clean, to: b.clean };
}

/** Remove a file and its editing history. The caller has closed any open editor first. */
export function removeFile(ref: ProjectRef, rel: string): string {
  const { clean, full } = fileOf(ref, rel);
  if (!fileExists(ref, clean)) throw new ProjectError(`There is no file ${clean}.`, 'missing');
  fs.unlinkSync(full);
  for (const f of collabFiles(ref, clean)) fs.rmSync(f, { force: true });
  pruneEmpty(filesDir(ref.dir), clean);
  pruneEmpty(collabDir(ref.dir), clean);
  return clean;
}

/**
 * Move a project to a new name, in the same collection or another, which is
 * created on the way when the caller may create it. Everything moves with the
 * directory: files, history, access, and the last build. The caller has
 * written and closed the project's open editors first.
 */
export function renameProject(root: string, ref: ProjectRef, collection: string, name: string): ProjectRef {
  if (!isValidUserName(collection)) throw new ProjectError('That collection name is not allowed.');
  if (!isValidUserName(name)) throw new ProjectError('A project name may use letters, digits, dot, underscore, and dash, and must not be a reserved word.');
  const dir = projectDir(root, collection, name);
  if (dir === ref.dir) return ref;
  if (fs.existsSync(dir)) throw new ProjectError(`Project ${collection}/${name} already exists.`, 'exists');
  fs.mkdirSync(projectsDir(root, collection), { recursive: true });
  fs.renameSync(ref.dir, dir);
  return { collection, name, dir };
}
