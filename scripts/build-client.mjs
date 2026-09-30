// Bundles the editor page's script (CodeMirror and the sync code) into
// dist/static/editor.js, and copies the stylesheet beside it. This is the
// one build step the pages have; everything else is served as written.
import { build } from 'esbuild';
import { copyFileSync, mkdirSync } from 'fs';

mkdirSync('dist/static', { recursive: true });
await build({
  entryPoints: ['client/editor.ts'],
  bundle: true,
  format: 'iife',
  target: 'es2020',
  minify: process.argv.includes('--minify'),
  sourcemap: process.argv.includes('--minify') ? false : 'inline',
  outfile: 'dist/static/editor.js',
  logLevel: 'warning',
});
copyFileSync('client/ohagi.css', 'dist/static/ohagi.css');
// pdf.js draws in a worker of its own, served beside the bundle.
copyFileSync('node_modules/pdfjs-dist/build/pdf.worker.min.mjs', 'dist/static/pdf.worker.mjs');
