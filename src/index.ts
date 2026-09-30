#!/usr/bin/env node
import './branding';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { api, request } from '../../mochiforge/src/cli-api';
import { normalizeApiPath } from '../../mochiforge/src/cli/api-cmd';
import { CliError, EXIT_FAIL, EXIT_USAGE, exitCodeForStatus } from '../../mochiforge/src/cli/exit';
import { readFileArg, readStdin } from '../../mochiforge/src/cli/input';
import { Cli, Command, Invocation, dispatch } from '../../mochiforge/src/cli/parse';
import { TARGET_OPTIONS, targetFrom } from '../../mochiforge/src/cli/target';
import {
  approveCredential,
  clearLogin,
  configuredHelper,
  credentialTarget,
  loginPath,
  readCredential,
  rejectCredential,
  saveLogin,
  setHelper,
} from '../../mochiforge/src/credentials';
import { resetTokenCmd, resetTokenHelp } from '../../mochiforge/src/reset-token-cli';
import { userAdminCommands, userCommands } from '../../mochiforge/src/cli/user-cmd';
import { bootstrapVault } from '../../mochiforge/src/vault';
import { seedTrustProxy } from '../../mochiforge/src/config';
import { shelfCommands } from './commands';
import { makeBackupCommands } from '../../mochiforge/src/cli/backup-cmd';
import { OHAGI_BACKUP } from './backup';
import { OHAGI_DEPLOY } from './deploy';
import { deployDestroyCmd, deployFlyCmd, deployResetTokenCmd, deployShowCmd } from '../../mochiforge/src/deploy-cli';

// The ohagi command: serve a shelf, or talk to a served one the way `mochi`
// talks to a vault. Built on mochiforge's CLI framework, so the option
// grammar, the exit codes, the credential store, and --json behave exactly
// as the mochi command's do.

const FOOTER = `Configuration:
  ohagi login https://tex.example.com   once, then the rest need no arguments

The shelf URL is kept in ~/.config/ohagi/login.json and the token in git's own
credential store. --host and --token override either for a single command, and
OHAGI_HOST and OHAGI_TOKEN sit between the two.

Shelf layout:
  <shelf>/shelf.json                          users and hashed tokens (server-managed)
  <shelf>/config.json                         settings: theme, limits
  <shelf>/collections/<c>/projects/<p>/files/ a project's files, plain files on disk

Everything is plain files, so on a machine you have a shell on, backup is cp -a.`;

// ---- serve ----

async function serveCmd(args: string[], usage: () => never) {
  let dir: string | null = null;
  let port = 3000;
  let host = '127.0.0.1';
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-h' || a === '--help') usage();
    else if (a === '-p' || a === '--port') port = parseInt(args[++i], 10);
    else if (a === '--host') host = args[++i];
    else if (a.startsWith('-')) throw new CliError(`Unknown option: ${a}`, EXIT_USAGE);
    else dir = a;
  }
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new CliError('Invalid port', EXIT_USAGE);
  const root = path.resolve(dir ?? process.env.OHAGI_SHELF ?? '.');
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new CliError(`Shelf directory does not exist: ${root}`);
  }
  try {
    fs.accessSync(root, fs.constants.W_OK);
  } catch {
    throw new CliError(`This process cannot write to the shelf directory ${root}.`);
  }
  // A shelf with no shelf.json is initialized on first start, as a vault is:
  // the owner token is minted and printed once, or supplied through
  // OHAGI_OWNER_TOKEN and then not printed at all.
  const boot = bootstrapVault(root, process.env.OHAGI_OWNER_TOKEN ?? null);
  // Set by `ohagi deploy fly`, which knows there is a TLS proxy in front but
  // cannot write to the volume before the shelf exists. It only seeds the
  // setting; config.json remains the place it lives.
  const seeded = process.env.OHAGI_TRUST_PROXY === '1' ? seedTrustProxy(root) : false;
  // Imported here rather than at the top, for mochi's reason: a command that
  // is not starting the server should not pay for loading it.
  const { createApp } = await import('./server');
  const { Docs } = await import('./docs');
  const { Compiler } = await import('./compile');
  const { History } = await import('./history');
  const docs = new Docs();
  const compiler = new Compiler();
  const history = new History(docs, () => host);
  const app = createApp(root, docs, compiler, history);
  process.on('uncaughtException', (err) => {
    console.error('uncaught exception (the server continues):', err);
  });
  process.on('unhandledRejection', (reason) => {
    console.error('unhandled rejection (the server continues):', reason);
  });
  const server = app.listen(port, host, () => {
    const url = `http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`;
    if (boot && boot.preset) {
      console.log('');
      console.log('Initialized a new shelf (no shelf.json found).');
      console.log(`Owner '${boot.username}' was given the token from OHAGI_OWNER_TOKEN, so it is not repeated here.`);
      console.log('');
    } else if (boot) {
      console.log('');
      console.log('Initialized a new shelf (no shelf.json found).');
      console.log(`Owner token for user '${boot.username}' (shown once; only its hash is stored):`);
      console.log('');
      console.log(`  ${boot.token}`);
      console.log('');
      console.log('Sign in on the web with it, or from the command line:');
      console.log(`  ohagi login ${url}`);
      console.log('');
    }
    if (seeded) console.log('Recorded network.trustProxy: true in config.json (OHAGI_TRUST_PROXY is set).');
    if (compiler.sandbox === 'none') {
      console.log('Compiles run without the bubblewrap sandbox, which this machine cannot provide: TeX\'s own');
      console.log('file and shell restrictions still apply, and lualatex is refused.');
    }
    console.log(`ohagi serving shelf ${root}`);
    console.log(`  ${url}`);
  });
  // Open files are written when they go idle, and all of them on the way out.
  const idle = setInterval(() => docs.unloadIdle(), 60_000);
  const stop = () => {
    clearInterval(idle);
    docs.flushAll();
    server.close();
    // What was edited since the last commit is committed on the way out.
    void history.commitAll().finally(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

// ---- login and logout ----

function promptToken(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function loginCmd(inv: Invocation) {
  const given = inv.args[0] ?? inv.str('host');
  if (!given) throw new CliError('Usage: ohagi login <url>', EXIT_USAGE);
  const target = credentialTarget(given);
  const host = target.url;

  const chosen = inv.str('helper');
  if (chosen) await setHelper(target.url, chosen);
  const helper = await configuredHelper(target.url);
  if (!helper) {
    console.error(`No credential helper is configured for ${target.url}, so git has nowhere to keep a token.`);
    console.error('Choose where the token should live and run login again:');
    console.error('  ohagi login --helper store        a file at ~/.git-credentials, in plain text');
    console.error('  ohagi login --helper cache        memory only, forgotten after 15 minutes');
    console.error('  ohagi login --helper libsecret    the desktop keyring, on Linux');
    console.error('  ohagi login --helper osxkeychain  the login keychain, on macOS');
    process.exit(EXIT_FAIL);
  }

  let token = inv.str('token');
  if (inv.bool('token-stdin')) token = (await readStdin()).trim();
  if (!token) token = await promptToken(`Token for ${target.url}: `);
  if (!token) throw new CliError('No token given.', EXIT_USAGE);

  // Verified before it is stored: a token that does not work is worse stored than absent.
  const who = await api({ host, token }, 'GET', '/api/whoami');
  const username = String(who.username ?? '');
  if (!username) throw new CliError(`${host} did not say who this token belongs to.`);

  await approveCredential(target, username, token);
  const stored = await readCredential(target);
  if (!stored || stored.password !== token) {
    console.error(`The credential helper '${helper}' did not keep the token for ${target.url}.`);
    process.exit(EXIT_FAIL);
  }
  saveLogin(host);
  console.log(`Stored the token for '${username}' at ${target.url} (helper: ${helper}).`);
  console.log(`ohagi commands talk to it by default (${loginPath()}). Run 'ohagi logout' to remove it.`);
}

async function logoutCmd(inv: Invocation) {
  const given = inv.args[0] ?? inv.str('host');
  const host = given ?? process.env.OHAGI_HOST ?? null;
  if (!host) throw new CliError('Usage: ohagi logout <url> (or log in first, so there is a default)', EXIT_USAGE);
  const target = credentialTarget(host);
  await rejectCredential(target);
  clearLogin(target.url);
  console.log(`Forgot the token for ${target.url}.`);
}

// ---- the registry ----

const commands: Command[] = [
  {
    path: ['serve'],
    summary: 'Serve a shelf directory over HTTP',
    description: `Initializes the directory as a shelf on first start, printing the owner
token once. Options: -p/--port <n> (default 3000), --host <addr> (default
127.0.0.1; use 0.0.0.0 behind a proxy).`,
    raw: true,
    args: [{ name: 'dir' }],
    run(inv) {
      return serveCmd(inv.argv, inv.help);
    },
  },
  {
    path: ['login'],
    summary: 'Store a token for a shelf and make it the default',
    args: [{ name: 'url' }],
    options: [
      ...TARGET_OPTIONS,
      { name: 'helper', type: 'string', value: '<h>', summary: 'Configure this git credential helper first' },
    ],
    run: loginCmd,
  },
  {
    path: ['logout'],
    summary: 'Forget the stored token for a shelf',
    args: [{ name: 'url' }],
    options: [{ name: 'host', type: 'string', value: '<url>', summary: 'Shelf URL when not given as an argument' }],
    run: logoutCmd,
  },
  ...shelfCommands,
  // Users and the current token: mochi's own commands, against the same routes.
  ...userCommands(),
  ...userAdminCommands(),
  {
    path: ['api'],
    summary: 'Call any route of the shelf JSON API and print what it answers',
    args: [{ name: 'path', required: true }],
    options: [
      { name: 'method', short: 'X', type: 'string', value: '<m>', summary: 'HTTP method (default GET, POST with a body)' },
      { name: 'input', type: 'string', value: '<file>', summary: "JSON body from a file, or '-' for stdin" },
      { name: 'include', short: 'i', type: 'boolean', summary: 'Print the status and content type to stderr' },
      ...TARGET_OPTIONS,
    ],
    async run(inv) {
      const target = await targetFrom(inv);
      const pathname = normalizeApiPath(inv.args[0]);
      const input = inv.str('input');
      const body = input ? await readFileArg(input) : undefined;
      const method = (inv.str('method') ?? (body === undefined ? 'GET' : 'POST')).toUpperCase();
      const r = await request(target, method, pathname, { body });
      if (inv.bool('include')) {
        process.stderr.write(`HTTP ${r.status}\n`);
        if (r.contentType) process.stderr.write(`content-type: ${r.contentType}\n\n`);
      }
      const out = r.body.endsWith('\n') || r.body === '' ? r.body : r.body + '\n';
      if (!r.ok) {
        process.stderr.write(out);
        process.exit(exitCodeForStatus(r.status));
      }
      process.stdout.write(out);
    },
  },
  {
    path: ['reset-token'],
    summary: 'Give a user a new token by editing the shelf on disk, when the old one is lost',
    description: resetTokenHelp(),
    raw: true,
    run: (inv) => resetTokenCmd(inv.argv, () => inv.help()),
  },
];

// A command that parses its own arguments, as the deploy commands do, since
// they are mochiforge's and take (args, usage).
function raw(path: string[], summary: string, description: string, run: (args: string[], usage: () => never) => void | Promise<void>): Command {
  return { path, summary, description: description || undefined, raw: true, run: (inv) => run(inv.argv, () => inv.help()) };
}

commands.push(
  raw(
    ['deploy', 'fly'],
    'Put a shelf on Fly.io, or deploy an update to one',
    `Usage: ohagi deploy fly <app> [--region <r>] [--volume <gb>] [--vm-size <s>]
                            [--vm-memory <m>] [--org <o>]
                            [--image <ref> | --from-source [--local-build]]

Needs flyctl installed, and fly auth login done. The app name is globally
unique on Fly and becomes the URL, https://<app>.fly.dev. Creating one mints
the owner token here and hands it to the server as a secret, then prints it
once the shelf answers. Run it again to deploy a new version; settings not
named by a flag keep whatever the live app has. A shelf is a directory on one
volume, so the app runs as exactly one machine.

Compiling wants memory: --vm-memory 2gb is a sensible start for a shelf used
by a few people, and lualatex documents want more.

--from-source builds the image from the checkouts you are running (ohagi and
mochiforge side by side); --local-build uses this machine's Docker rather than
Fly's builder. --image <ref> deploys some other published tag. The image
carries a full TeX Live, so it is several gigabytes.

See also: ohagi deploy fly show <app>, ohagi deploy fly destroy <app>.`,
    (args, usage) => deployFlyCmd(args, usage, OHAGI_DEPLOY)
  ),
  raw(['deploy', 'fly', 'show'], 'What Fly has for this app, and whether the shelf answers', '', (args, usage) => deployShowCmd(args, usage, OHAGI_DEPLOY)),
  raw(
    ['deploy', 'fly', 'reset-token'],
    "Give a user of the app's shelf a new token, when the owner's is lost",
    `Usage: ohagi deploy fly reset-token <app> [--user <name>] [--revoke-others]

Mints a token here and runs ohagi reset-token on the machine over fly ssh,
handing it only the token's hash. Needs flyctl and the Fly login that owns the
app.`,
    (args, usage) => deployResetTokenCmd(args, usage, OHAGI_DEPLOY)
  ),
  raw(['deploy', 'fly', 'destroy'], 'Destroy the app and its volume, and with them the shelf', 'No undo. Pass --yes to skip the confirmation.', (args, usage) =>
    deployDestroyCmd(args, usage, OHAGI_DEPLOY)
  ),
  ...makeBackupCommands(OHAGI_BACKUP)
);

const cli: Cli = {
  name: 'ohagi',
  groups: [
    { name: 'collection', summary: 'List, create, and own collections' },
    { name: 'project', summary: 'List, create, view, and delete projects' },
    { name: 'collab', summary: "Manage a project's collaborators" },
    { name: 'file', summary: "Copy, move, and delete a project's files" },
    { name: 'user', summary: 'Manage the shelf’s users and their tokens (site admin)' },
    { name: 'deploy', summary: 'Put a shelf on Fly.io' },
    { name: 'backup', summary: 'Copy a shelf to a directory on this machine' },
  ],
  commands,
  footer: FOOTER,
};

async function main() {
  await dispatch(cli, process.argv.slice(2));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(e instanceof CliError ? e.code : EXIT_FAIL);
});
