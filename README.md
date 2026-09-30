# ohagi

A self-hosted LaTeX editor with the shape of Overleaf, where several people edit one file at once. One Node process, no database, state as plain files in one directory.

ohagi is built from the same parts as [Mochi Forge](https://github.com/magland/mochiforge), its sibling (checked out in the next directory for development), as [dango](https://github.com/magland/dango) is. Where mochi has a *vault* of repositories, ohagi has a *shelf* of projects, grouped into collections in the same way, and the two look and behave alike: the same page layout, themes, sign-in, account pages, tokens, permissions, and command line.

This is early. Collaborative editing, sign-in, members-only projects, and creating projects work; compiling, the file tree, project settings, and git come next.

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
- **Projects in collections,** addressed as `/<collection>/<project>`, with mochi's naming rules.
- **Members only.** A project is private: its collaborators, its collection's owners, and site admins see it, and nobody else learns it exists. Roles are mochi's: `read` opens the editor read-only, `write` edits, `admin` manages. A user owns the collection named after them.
- **Sign-in and accounts** are mochi's own pages: tokens, passkeys, codes carried from another browser, and GitHub sign-in, with the same sliding sessions and CSRF checks.
- **A command line** on mochi's framework: `ohagi serve`, `login`, `logout`, `whoami`, `api`, and `reset-token`.

## How editing works

The editor is CodeMirror 6 with its collab extension. The server is the single authority over each open file: every accepted change moves the file's version up by one, and a page pushes its changes together with the version they were made against. A push against an older version is refused as stale, and the page waits for the changes it is missing, rebases its own over them, and pushes again. Changes come down to every page over server-sent events, the pusher's own included, which is how a page learns its changes were taken.

Only the page rebases. We first let the server rebase stale pushes itself (collab provides `rebaseUpdates` for this), and the concurrency tests found that the page and the server then occasionally disagree: the page rebases over each batch of changes as it arrives, the server over all of them composed, and the two are not always the same. An insertion inside a range that was deleted and then refilled lands differently. Refusing stale pushes costs a round trip under contention, which at the scale of a few people in one file is negligible.

Remote cursors travel separately and are held in memory only. A page sends its selection in the text at its synced version, and the server carries it forward over later changes before passing it on. The name shown is the signed-in user's, set by the server.

The sync API takes either of mochi's credentials: the browser's session cookie, with the session's CSRF value on every write, or a bearer token.

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
```

A file stays a plain file, written a moment after typing stops. Each accepted change is appended to the log before it is acknowledged, so after a crash loading replays whatever the file missed. The log also keeps recent history, so a page left open across a restart catches up from its own version rather than starting over. If the file on disk is not the text its metadata describes (it was edited with another tool while the server was stopped), a new *epoch* starts and open pages are sent the whole text.

## Relationship to mochiforge

ohagi imports mochiforge's modules directly from the sibling checkout (`../mochiforge`), as dango does: the identity store, sessions and CSRF, permissions, the page layout, stylesheet, themes, and page script, the sign-in and account routes, markdown and HTML templates, rate limiting, and the CLI framework. mochi's `setNaming` lets the shared code spell ohagi's names, so a shelf mints `ohagi_` tokens, sets an `ohagi_session` cookie, keeps identity in `shelf.json`, and draws ohagi's logo in the shared layout. Making mochi's pieces reusable took small changes on mochi's side, each leaving mochi's own behaviour as it was: the account routes and asset routes moved into modules of their own, and the layout gained a few naming hooks.

The trade-off is dango's: ohagi does not build without the sibling checkout present. The compiled output carries the mochiforge modules it uses (`dist/mochiforge` beside `dist/ohagi`), so what ships does not.

## Development

```bash
npm run typecheck
npm test          # scripted pages typing into one file at once, through a restart; permissions; creating
```

The tests drive `client/sync.ts`, the same module the browser runs, from Node, and sign in through mochi's real `/login` form. The editor bundle (`dist/static/editor.js`, about 110 KB gzipped) is the one build step the pages have.

## Limitations

- A file edited on disk while the server has it open is overwritten on the next write. Edits made on disk while the server is stopped are picked up, at the cost of a new epoch.
- When a page's history cannot be continued (a new epoch, or a page offline for longer than the kept history of 1000 changes), its unsent edits are lost, and the page says so.
- Access is checked when an editor connects. Someone removed from a project while their editor is open keeps its stream until they reload.
- Users, collaborators, and collection owners are managed by editing the shelf for now; the admin and settings pages are next.

## License

Apache License 2.0.
