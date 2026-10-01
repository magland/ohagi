import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DeployProfile, die } from '../../mochiforge/src/deploy-cli';

// `ohagi deploy fly`, which is `mochi deploy fly` with a shelf's profile:
// the app, the single volume and machine, the owner token minted here and
// adopted by the server, and the settings read back off the live app are all
// mochiforge's code. What is ohagi's own is below: the image's name, where
// the shelf mounts, and how --from-source assembles a build context.

export const IMAGE_REPO = 'ghcr.io/magland/ohagi';
const PACKAGE_NAME = '@magland/ohagi';

/**
 * The package root this process runs from: a checkout under tsx, a checkout's
 * dist, or an installed package. The depth differs between them (src/ is one
 * level down, dist/ohagi/src/ three), so it is found by walking up to the
 * package.json that names this package rather than by counting.
 */
export function packageRoot(): string | null {
  let dir = __dirname;
  for (;;) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { name?: unknown };
      if (pkg.name === PACKAGE_NAME) return dir;
    } catch {
      // not here
    }
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

export function ownVersion(): string {
  const root = packageRoot();
  if (root) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { version?: unknown };
      if (typeof pkg.version === 'string' && pkg.version) return pkg.version;
    } catch {
      /* fall through */
    }
  }
  die("Could not read this package's version, so there is no image tag to deploy. Pass --image <ref>.");
}

/**
 * The files an image build needs, relative to the directory holding both
 * checkouts. The Dockerfile names the same paths, and Dockerfile.dockerignore
 * lets exactly these through when the parent directory is the context.
 */
const OHAGI_FILES = ['package.json', 'package-lock.json', 'tsconfig.json', 'src', 'client', 'scripts/build-client.mjs'];
const MOCHIFORGE_FILES = ['src'];
/** arewehuman's sources, for recording how projects are written (src/recording.ts). */
const AREWEHUMAN_FILES = ['src'];

/**
 * A build context for --from-source, assembled in a temporary directory.
 *
 * ohagi compiles mochiforge's and arewehuman's sources in with its own, so a
 * build needs all three checkouts, side by side, as they sit on disk. Handing Fly the parent
 * directory would upload whatever else lives there, since how flyctl filters a
 * context is not something to rely on, so the context is copied instead: the
 * two source trees, the manifests, and the Dockerfile at its root, a few
 * hundred kilobytes in all. The copy is removed when the deploy ends.
 */
export function stageBuildContext(): { dir: string; cleanup(): void } {
  const root = packageRoot();
  const sibling = root ? path.resolve(root, '..', 'mochiforge') : null;
  const awh = root ? path.resolve(root, '..', 'arewehuman') : null;
  if (!root || !fs.existsSync(path.join(root, 'Dockerfile')) || !fs.existsSync(path.join(root, 'src'))) {
    die(
      '--from-source builds the image from an ohagi checkout, and this is not one:\n' +
        `  ${root ?? __dirname}\n\n` +
        'The published package contains only the compiled output, so there is nothing to\n' +
        'build. Clone both repositories side by side and run the deploy from there:\n\n' +
        '  git clone https://github.com/magland/mochiforge\n' +
        '  git clone https://github.com/magland/arewehuman\n' +
        '  git clone https://github.com/magland/ohagi && cd ohagi && npm install\n' +
        '  npx tsx src/index.ts deploy fly <app> --from-source\n'
    );
  }
  if (!sibling || !fs.existsSync(path.join(sibling, 'src'))) {
    die(
      `ohagi builds against mochiforge's sources, expected beside it at ${sibling ?? '../mochiforge'}.\n` +
        'Clone it there: git clone https://github.com/magland/mochiforge'
    );
  }
  if (!awh || !fs.existsSync(path.join(awh, 'src'))) {
    die(
      `ohagi builds against arewehuman's sources, expected beside it at ${awh ?? '../arewehuman'}.\n` +
        'Clone it there: git clone https://github.com/magland/arewehuman'
    );
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ohagi-build-'));
  for (const f of OHAGI_FILES) {
    const from = path.join(root, f);
    if (fs.existsSync(from)) fs.cpSync(from, path.join(dir, 'ohagi', f), { recursive: true });
  }
  for (const f of MOCHIFORGE_FILES) {
    fs.cpSync(path.join(sibling, f), path.join(dir, 'mochiforge', f), { recursive: true });
  }
  for (const f of AREWEHUMAN_FILES) {
    fs.cpSync(path.join(awh, f), path.join(dir, 'arewehuman', f), { recursive: true });
  }
  fs.copyFileSync(path.join(root, 'Dockerfile'), path.join(dir, 'Dockerfile'));
  let removed = false;
  return {
    dir,
    cleanup() {
      if (removed) return;
      removed = true;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

export const OHAGI_DEPLOY: DeployProfile = {
  imageRepo: IMAGE_REPO,
  version: ownVersion,
  buildContext: stageBuildContext,
  volumeName: 'shelf',
  mountPath: '/shelf',
  remoteCli: 'node /app/dist/ohagi/src/index.js',
  lfsBucket: false,
  // Counted in connections rather than requests, as dango's are: every open
  // editor holds one event stream for as long as it is open. Node holds idle
  // streams cheaply.
  concurrency: { type: 'connections', soft: 800, hard: 1000 },
  contents: 'projects, their files and history, users',
  // TeX wants more than a chat server: 2gb holds a couple of compiles at once.
  defaultMemory: '2gb',
  firstSteps: (url, username) => [
    `To start using the shelf in a browser, open its sign-in page and paste that`,
    `token; it signs you in as '${username}':`,
    '',
    `  ${url}/login`,
    '',
    'From there New project makes the first project, and the Admin page adds people',
    '(each gets a token of their own to hand over).',
    '',
    "To use the CLI instead, hand the same token to git's credential store, which is",
    'what login is for:',
    '',
    `  ohagi login ${url}`,
    '',
    'It asks for the token without echoing it, checks it, and remembers this shelf,',
    'so these need no arguments afterwards:',
    '',
    '  ohagi whoami',
    '  ohagi user add alice',
    '  ohagi project create owner/paper',
  ],
};
