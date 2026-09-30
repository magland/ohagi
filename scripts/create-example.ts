import '../src/branding';
import * as fs from 'fs';
import * as path from 'path';
import { setCollaborator } from '../../mochiforge/src/perms';
import { addUserToken } from '../../mochiforge/src/vault';
import { createCollection, createProject, filesDir, setProjectMeta } from '../src/projects';

// An example shelf with sample people and projects, for npm run dev and the
// tests. The tokens are fixed and known, which is fine for a shelf that only
// ever listens on 127.0.0.1.

export const EXAMPLE_TOKENS = {
  dev: 'ohagi_example_dev_token_0000000',
  alice: 'ohagi_example_alice_token_00000',
  bob: 'ohagi_example_bob_token_0000000',
  carol: 'ohagi_example_carol_token_00000',
};

export function createExample(root: string): void {
  fs.mkdirSync(root, { recursive: true });
  addUserToken(root, 'dev', { siteAdmin: true, token: EXAMPLE_TOKENS.dev });
  addUserToken(root, 'alice', { token: EXAMPLE_TOKENS.alice });
  addUserToken(root, 'bob', { token: EXAMPLE_TOKENS.bob });
  addUserToken(root, 'carol', { token: EXAMPLE_TOKENS.carol });

  // alice's paper, which bob may write and carol may read.
  const paper = createProject(root, 'alice', 'paper', 'A short example paper');
  setCollaborator(paper.dir, 'bob', 'write');
  setCollaborator(paper.dir, 'carol', 'read');
  const files = filesDir(paper.dir);
  fs.mkdirSync(path.join(files, 'figures'), { recursive: true });
  fs.writeFileSync(
    path.join(files, 'main.tex'),
    `\\documentclass{article}
\\usepackage{amsmath}
\\usepackage{graphicx}

\\title{An Example Paper}
\\author{Alice \\and Bob}

\\begin{document}
\\maketitle

\\section{Introduction}
A limitation of most editors is that only one person can type in a file at a
time. Here we describe one where several can.

\\section{Method}
The server holds each open file and a version number, and accepts changes
made against the current version; a page that is behind catches up first.
\\begin{equation}
  v_{n+1} = v_n + 1.
\\end{equation}

\\input{results}

\\bibliographystyle{plain}
\\bibliography{refs}
\\end{document}
`
  );
  fs.writeFileSync(path.join(files, 'results.tex'), `\\section{Results}\nTwo people typing into one paragraph see each other's text as it is typed.\n`);
  fs.writeFileSync(
    path.join(files, 'refs.bib'),
    `@article{example2026,\n  author  = {Example, Alice},\n  title   = {An example reference},\n  journal = {Journal of Examples},\n  year    = {2026},\n}\n`
  );
  fs.writeFileSync(path.join(files, 'figures', 'placeholder.png'), Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'));

  // A lab collection, owned by dev as a site admin would create it, with a
  // proposal bob is on and alice is not.
  createCollection(root, 'lab');
  const proposal = createProject(root, 'lab', 'proposal', 'Grant proposal, specific aims');
  setCollaborator(proposal.dir, 'bob', 'admin');
  setProjectMeta(proposal, { description: 'Grant proposal, specific aims', created: new Date().toISOString() });
}

if (require.main === module) {
  const root = path.resolve(process.argv[2] ?? 'example-root');
  if (fs.existsSync(path.join(root, 'shelf.json'))) {
    console.log(`Example shelf at ${root} already exists; leaving it alone (delete it to start over).`);
  } else {
    createExample(root);
    console.log(`Example shelf at ${root}`);
  }
  // The tokens are fixed, so they are the same for a shelf made earlier.
  console.log(`  site admin: dev    token ${EXAMPLE_TOKENS.dev}`);
  console.log(`  user:       alice  token ${EXAMPLE_TOKENS.alice}  (owns alice/paper)`);
  console.log(`  user:       bob    token ${EXAMPLE_TOKENS.bob}  (writes alice/paper, admin on lab/proposal)`);
  console.log(`  user:       carol  token ${EXAMPLE_TOKENS.carol}  (reads alice/paper)`);
}
