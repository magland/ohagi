# ohagi

A self-hosted LaTeX editor with the shape of Overleaf, where several people edit one file at once. One Node process, no database, state as plain files in one directory.

ohagi is built from the same parts as [Mochi Forge](https://github.com/magland/mochiforge), its sibling (checked out in the next directory for development), as [dango](https://github.com/magland/dango) is. Where mochi has a *vault* of repositories, ohagi has a *shelf* of projects, grouped into collections in the same way, and the two look and behave alike: the same page layout, themes, sign-in, account pages, tokens, permissions, and command line.

This is early, but the parts are there: collaborative editing, compiling to PDF, files, git clone, sign-in, members-only projects, settings, user administration, backup, deploying to Fly.io, and the command line.

## Try it

```bash
npm install
npm run example   # creates example-root/, a shelf with four users and two projects
npm run dev       # serves it at http://127.0.0.1:3000
```

The example prints its users' tokens. Sign in as `alice` at `/login` and open `alice/paper`; sign in as `bob` in another browser (or a private window) and open the same file, and type in both.

A new shelf is any empty directory: `ohagi serve mydir` initializes it and prints an owner token once, exactly as `mochi serve` does.

## What it does

- **Collaborative editing** of every text file in a project, `.tex`, `.bib`, `.sty`, and the rest, in CodeMirror 6, with each person's cursor and name shown to the others.
- **Compiling to PDF** with latexmk (pdflatex, xelatex, or lualatex), in a sandbox, with the PDF beside the editor, errors linked to their lines, and every open editor of the project refreshed when anyone compiles. Recompile is Ctrl+S or Ctrl+Enter, and Auto compiles a moment after typing stops. Double-clicking the PDF goes to the source that made that spot (SyncTeX), in whichever file it is.
- **git clone** of a project at its own address, read-only. The shelf commits a project's files a minute after editing stops, attributed to whoever edited, and again before any clone, so a clone or a pull has what the editors show.
- **Files:** create, upload, rename or move, and delete, with anyone who has the file open following it; figures and other binary files are uploaded and served as they are.
- **Projects in collections,** addressed as `/<collection>/<project>`, with mochi's naming rules.
- **Members only.** A project is private: its collaborators, its collection's owners, and site admins see it, and nobody else learns it exists. Roles are mochi's: `read` opens the editor read-only, `write` edits, `admin` manages. A user owns the collection named after them.
- **Sign-in and accounts** are mochi's own pages: tokens, passkeys, codes carried from another browser, and GitHub sign-in, with the same sliding sessions and CSRF checks.
- **Project settings** in the shape of a repository's: the description, the compiler, public or private, collaborators and their roles, renaming or moving, and deletion; and a collection's owners.
- **Administration** by mochi's own pages: users, their tokens and passkeys, the site-admin bit, sign-in with GitHub, and the theme.
- **Backup** over mochi's protocol, with mochi's client: `ohagi backup ~/backups/shelf` keeps an incremental copy, and its `current/` is a servable shelf.
- **Deploying** to Fly.io with mochi's deploy: `ohagi deploy fly <app>` runs the published image on one machine and one volume, and `--from-source` builds one from the checkouts. The image is a thin layer on a base image holding Node and a full TeX Live (`Dockerfile.base`, published as `ghcr.io/magland/ohagi-tex:trixie`), which is rebuilt only when it changes and monthly, so a commit's image builds in a minute or two. CI redeploys shelf1 after every green build of `main`.
- **A command line** on mochi's framework: `ohagi serve`, `login`, `whoami`, `collection`, `project`, `collab`, `file`, `compile`, `user`, `backup`, `deploy`, `api`, and `reset-token`. The `user`, `backup`, and `deploy` commands are mochi's own, against the same routes.

## How editing works

The editor is CodeMirror 6 with its collab extension. The server is the single authority over each open file: every accepted change moves the file's version up by one, and a page pushes its changes together with the version they were made against. A push against an older version is refused as stale, and the page waits for the changes it is missing, rebases its own over them, and pushes again. Changes come down to every page over server-sent events, the pusher's own included, which is how a page learns its changes were taken.

Only the page rebases. We first let the server rebase stale pushes itself (collab provides `rebaseUpdates` for this), and the concurrency tests found that the page and the server then occasionally disagree: the page rebases over each batch of changes as it arrives, the server over all of them composed, and the two are not always the same. An insertion inside a range that was deleted and then refilled lands differently. Refusing stale pushes costs a round trip under contention, which at the scale of a few people in one file is negligible.

Remote cursors travel separately and are held in memory only. A page sends its selection in the text at its synced version, and the server carries it forward over later changes before passing it on. The name shown is the signed-in user's, set by the server.

The sync API takes either of mochi's credentials: the browser's session cookie, with the session's CSRF value on every write, or a bearer token.

## How compiling works

A compile copies the project's files into `build/src/` beside `files/` (bringing an existing copy up to date, so latexmk can reuse its auxiliary files) and runs latexmk there. A document is untrusted input, so it is held in three ways:

- **TeX's own settings:** no shell escape, and `openin_any` and `openout_any` set to paranoid, so a document cannot read or write by an absolute path or one that climbs out of the directory. TeX Live's default lets a document `\input` any file the server can read.
- **A bubblewrap namespace,** where the machine allows one: the system read-only, only the parts of `/etc` TeX needs, no network, and the build directory the only writable place. The shelf is not in it at all. lualatex's Lua can open files without asking TeX, so lualatex relies on the namespace and is refused on a machine without it.
- **Limits:** a timeout that kills the whole compile, and caps on memory and CPU time.

One detail is worth recording. latexmk is run without an output directory, because TeX also looks for input files inside an output directory, by a joined path that `openin_any` does not check: in our tests `../../../shelf.json` read through `build/out/` escaped the paranoid setting. The tests try that and the other ways out, with and without the namespace.

## The shelf

```
<shelf>/
  shelf.json                  users and hashed tokens (a vault's vault.json)
  config.json                 settings, a vault's shape: theme, limits
  .secret                     session-cookie signing key
  collections/
    alice/
      collection.json         the collection's explicit owners
      projects/
        paper/
          access.json         private flag and collaborators (a repository's mochi.json)
          project.json        description
          files/              the project's files, and nothing else
            main.tex
          collab/
            main.tex.json     epoch, version, and hash of the text as last written
            main.tex.log      one line per accepted change
          build/              the last compile: src/ (a copy of files/ with latexmk's output) and result.json
          repo.git/           the project's history, committed from files/, which git clone serves
```

A file stays a plain file, written a moment after typing stops. Each accepted change is appended to the log before it is acknowledged, so after a crash loading replays whatever the file missed. The log also keeps recent history, so a page left open across a restart catches up from its own version rather than starting over. If the file on disk is not the text its metadata describes (it was edited with another tool while the server was stopped), a new *epoch* starts and open pages are sent the whole text.

## Relationship to mochiforge

ohagi imports mochiforge's modules directly from the sibling checkout (`../mochiforge`), as dango does: the identity store, sessions and CSRF, permissions, the page layout, stylesheet, themes, and page script, the sign-in, account, and admin routes, the user and token API, the user commands, markdown and HTML templates, rate limiting, and the CLI framework. mochi's `setNaming` lets the shared code spell ohagi's names, so a shelf mints `ohagi_` tokens, sets an `ohagi_session` cookie, keeps identity in `shelf.json`, and draws ohagi's logo in the shared layout. Making mochi's pieces reusable took small changes on mochi's side, each leaving mochi's own behaviour as it was: the account, admin, and asset routes, the user API, and the user commands moved into modules of their own, and the layout gained a few naming hooks. Those changes are on mochi's `ohagi-shared` branch for now.

The trade-off is dango's: ohagi does not build without the sibling checkout present. The compiled output carries the mochiforge modules it uses (`dist/mochiforge` beside `dist/ohagi`), so what ships does not.

## Development

```bash
npm run typecheck
npm test          # concurrent editing through a restart, permissions, files, the CLI, and compiling (sandbox escapes included)
```

The tests drive `client/sync.ts`, the same module the browser runs, from Node, and sign in through mochi's real `/login` form. The editor bundle (`dist/static/editor.js`, about 110 KB gzipped) is the one build step the pages have.

## Limitations

- A file edited on disk while the server has it open is overwritten on the next write. Edits made on disk while the server is stopped are picked up, at the cost of a new epoch.
- When a page's history cannot be continued (a new epoch, or a page offline for longer than the kept history of 1000 changes), its unsent edits are lost, and the page says so.
- Access is checked when an editor connects. Someone removed from a project while their editor is open keeps its stream until they reload.
- A collection's owners are managed from the command line (`ohagi collection owner add`); there is no collection settings page yet.

## License

Apache License 2.0.
