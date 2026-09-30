#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { createApp, findStaticDir } from './server';
import { Shelf } from './shelf';

// The ohagi command. For now only `serve`; the rest of the CLI (users,
// projects, login, deploy, backup) comes from mochiforge's framework, as
// dango's does.

const USAGE = `Usage: ohagi serve <shelf> [--port 3000] [--host 127.0.0.1]`;

function serve(args: string[]): void {
  let dir: string | null = null;
  let port = 3000;
  let host = '127.0.0.1';
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-p' || a === '--port') port = parseInt(args[++i], 10);
    else if (a === '--host') host = args[++i];
    else if (a.startsWith('-')) fail(`Unknown option: ${a}`);
    else dir = a;
  }
  if (!dir) fail(USAGE);
  const root = path.resolve(dir);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) fail(`Shelf directory does not exist: ${root}`);
  const shelf = new Shelf(root);
  const app = createApp(shelf, findStaticDir());
  const server = app.listen(port, host, () => {
    console.log(`ohagi serving ${root} at http://${host}:${port}`);
  });
  const idle = setInterval(() => shelf.unloadIdle(), 60_000);
  const stop = () => {
    clearInterval(idle);
    shelf.flushAll();
    server.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

function fail(msg: string): never {
  console.error(msg);
  process.exit(2);
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'serve') serve(rest);
else fail(USAGE);
