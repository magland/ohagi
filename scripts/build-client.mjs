// Bundles the editor page's script (CodeMirror and the sync code) into
// dist/static/editor.js, and the who-wrote-what viewer (arewehuman's, from the
// sibling checkout) into dist/static/awh-viewer.js, and copies the stylesheets
// beside them. These are the build steps the pages have; everything else is
// served as written.
import { build } from 'esbuild';
import { copyFileSync, mkdirSync } from 'fs';
import path from 'path';

const minify = process.argv.includes('--minify');
const common = { bundle: true, format: 'iife', target: 'es2020', minify, sourcemap: minify ? false : 'inline', logLevel: 'warning' };
mkdirSync('dist/static', { recursive: true });
await build({ ...common, entryPoints: ['client/editor.ts'], outfile: 'dist/static/editor.js' });
// arewehuman's sources find their packages from where they sit; React must be
// this one copy, ohagi's.
const own = (p) => path.resolve('node_modules', p);
await build({
  ...common,
  entryPoints: ['client/viewer.tsx'],
  outfile: 'dist/static/awh-viewer.js',
  jsx: 'automatic',
  alias: { react: own('react'), 'react-dom': own('react-dom') },
});
copyFileSync('client/ohagi.css', 'dist/static/ohagi.css');
copyFileSync('../arewehuman/src/styles.css', 'dist/static/awh-viewer.css');
// pdf.js draws in a worker of its own, served beside the bundle.
copyFileSync('node_modules/pdfjs-dist/build/pdf.worker.min.mjs', 'dist/static/pdf.worker.mjs');
