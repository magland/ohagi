# ohagi

A self-hosted LaTeX editor with the shape of Overleaf, where several people edit one file at once. It is a sibling of [Mochi Forge](https://github.com/magland/mochiforge) and [dango](https://github.com/magland/dango), and makes the same kinds of decisions: one Node process, no database, state as plain files in one directory.

This is a prototype. What exists is the part most likely to go wrong, collaborative editing of a text file; sign-in, the file tree, compiling, and git come next.

## Try it

```bash
npm install
npm run example   # creates example-root/, a shelf with one small paper
npm run dev       # serves it at http://127.0.0.1:3000
```

Open a `.tex` file in two browser windows and type in both. There is no sign-in yet (each page asks for a name, as the others will see it), so the server listens on localhost only.

## How editing works

The editor is CodeMirror 6 with its collab extension. The server is the single authority over each open file: every accepted change moves the file's version up by one, and a page pushes its changes together with the version they were made against. A push against an older version is refused as stale, and the page waits for the changes it is missing, rebases its own over them, and pushes again. Changes come down to every page over server-sent events, the pusher's own included, which is how a page learns its changes were taken.

Only the page rebases. We first let the server rebase stale pushes itself (collab provides `rebaseUpdates` for this), and the concurrency tests found that the page and the server then occasionally disagree: the page rebases over each batch of changes as it arrives, the server over all of them composed, and the two are not always the same. An insertion inside a range that was deleted and then refilled lands differently. Refusing stale pushes costs a round trip under contention, which at the scale of a few people in one file is negligible.

Remote cursors travel separately and are held in memory only. A page sends its selection in the text at its synced version, and the server carries it forward over later changes before passing it on.

## The shelf

A shelf is one directory:

```
<shelf>/
  projects/
    paper/
      files/            the project's files, and nothing else
        main.tex
      collab/
        main.tex.json   epoch, version, and hash of the text as last written
        main.tex.log    one line per accepted change
```

A file stays a plain file, written a moment after typing stops. Each accepted change is appended to the log before it is acknowledged, so after a crash loading replays whatever the file missed. The log also keeps recent history, so a page left open across a restart catches up from its own version rather than starting over. If the file on disk is not the text its metadata describes (it was edited with another tool while the server was stopped), a new *epoch* starts and open pages are sent the whole text.

## Development

```bash
npm run typecheck
npm test          # several scripted pages typing into one file at once, through a restart
```

The tests drive `client/sync.ts`, the same module the browser runs, from Node. The editor bundle (`dist/static/editor.js`, about 110 KB gzipped) is the one build step the pages have.

## Limitations

- No sign-in, users, or permissions yet.
- A file edited on disk while the server has it open is overwritten on the next write. Edits made on disk while the server is stopped are picked up, at the cost of a new epoch.
- When a page's history cannot be continued (a new epoch, or a page offline for longer than the kept history of 1000 changes), its unsent edits are lost, and the page says so.

## License

Apache License 2.0.
