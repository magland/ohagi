import * as fs from 'fs';
import * as path from 'path';
import { api, requestBytes } from '../../mochiforge/src/cli-api';
import { CliError, EXIT_USAGE, exitCodeForStatus } from '../../mochiforge/src/cli/exit';
import { JSON_OPTION, jsonMode, pickFields, pickObject, printJson } from '../../mochiforge/src/cli/output';
import { Command, Invocation, OptionSpec } from '../../mochiforge/src/cli/parse';
import { TARGET_OPTIONS, targetFrom } from '../../mochiforge/src/cli/target';

// The shelf's own commands: collections and their owners, projects, and
// collaborators, in the grammar mochi's collection and collab commands use,
// against the routes in src/api.ts.

const YES_OPTION: OptionSpec = { name: 'yes', type: 'boolean', summary: 'Required: confirm that this cannot be undone' };

/** collection/project, as the commands take it. */
function projectArg(inv: Invocation, index: number): { collection: string; project: string; path: string } {
  const given = inv.args[index] ?? '';
  const m = /^([^/\s]+)\/([^/\s]+)$/.exec(given);
  if (!m) throw new CliError(`Name the project as <collection>/<project>, not '${given}'.`, EXIT_USAGE);
  return { collection: m[1], project: m[2], path: `/api/projects/${encodeURIComponent(m[1])}/${encodeURIComponent(m[2])}` };
}

function print(inv: Invocation, data: Record<string, unknown>, text: () => void): void {
  const json = jsonMode(inv);
  if (json.enabled) printJson(pickObject(data, json.fields));
  else text();
}

export const shelfCommands: Command[] = [
  // ---- collections ----
  {
    path: ['collection', 'list'],
    summary: 'List the collections, with how many of their projects you can open',
    options: [JSON_OPTION, ...TARGET_OPTIONS],
    async run(inv) {
      const target = await targetFrom(inv);
      const data = await api(target, 'GET', '/api/collections');
      const rows = (data.collections ?? []) as { name: string; projectCount: number; owners: string[] }[];
      const json = jsonMode(inv);
      if (json.enabled) {
        printJson({ collections: pickFields(rows as unknown as Record<string, unknown>[], json.fields) });
        return;
      }
      if (!rows.length) {
        console.log(`No collections on ${target.host}`);
        return;
      }
      const width = Math.max(...rows.map((r) => r.name.length));
      for (const r of rows) console.log(`${r.name.padEnd(width)}  ${r.projectCount} project${r.projectCount === 1 ? '' : 's'}`);
    },
  },
  {
    path: ['collection', 'add'],
    summary: 'Create an empty collection',
    description: `The collection named after you is yours to create; any other name takes a site
admin. Creating a project in a collection that does not exist yet creates it on
the way, so this is for a collection that should exist before its projects do.`,
    args: [{ name: 'name', required: true }],
    options: [JSON_OPTION, ...TARGET_OPTIONS],
    async run(inv) {
      const target = await targetFrom(inv);
      const data = await api(target, 'POST', '/api/collections', { name: inv.args[0] });
      print(inv, data, () => console.log(`Created collection ${data.name}`));
    },
  },
  {
    path: ['collection', 'view'],
    summary: "Show a collection's owners and the projects in it you can open",
    args: [{ name: 'name', required: true }],
    options: [JSON_OPTION, ...TARGET_OPTIONS],
    async run(inv) {
      const target = await targetFrom(inv);
      const data = await api(target, 'GET', `/api/collections/${encodeURIComponent(inv.args[0])}`);
      print(inv, data, () => {
        console.log(`${data.name}`);
        console.log(`  owners: ${[data.name, ...((data.owners ?? []) as string[])].join(', ')} (the first by name)`);
        const projects = (data.projects ?? []) as string[];
        console.log(`  projects: ${projects.length ? projects.join(', ') : '(none you can open)'}`);
      });
    },
  },
  {
    path: ['collection', 'owner', 'add'],
    summary: 'Make a user an owner of a collection',
    description: `An owner holds the admin role on every project in the collection and may create
projects in it. The user the collection is named after owns it without being listed.`,
    args: [
      { name: 'collection', required: true },
      { name: 'username', required: true },
    ],
    options: [JSON_OPTION, ...TARGET_OPTIONS],
    async run(inv) {
      const target = await targetFrom(inv);
      const [c, u] = inv.args;
      const data = await api(target, 'PUT', `/api/collections/${encodeURIComponent(c)}/owners/${encodeURIComponent(u)}`);
      print(inv, data, () => console.log(data.note ?? `Owners of ${c}: ${((data.owners ?? []) as string[]).join(', ')}`));
    },
  },
  {
    path: ['collection', 'owner', 'remove'],
    summary: "Remove a user from a collection's owners",
    args: [
      { name: 'collection', required: true },
      { name: 'username', required: true },
    ],
    options: [JSON_OPTION, ...TARGET_OPTIONS],
    async run(inv) {
      const target = await targetFrom(inv);
      const [c, u] = inv.args;
      const data = await api(target, 'DELETE', `/api/collections/${encodeURIComponent(c)}/owners/${encodeURIComponent(u)}`);
      print(inv, data, () => console.log(`Owners of ${c}: ${((data.owners ?? []) as string[]).join(', ') || '(none listed)'}`));
    },
  },

  // ---- projects ----
  {
    path: ['project', 'list'],
    summary: 'List the projects you can open',
    options: [JSON_OPTION, ...TARGET_OPTIONS],
    async run(inv) {
      const target = await targetFrom(inv);
      const data = await api(target, 'GET', '/api/projects');
      const rows = (data.projects ?? []) as { collection: string; name: string; role: string; private: boolean; description: string }[];
      const json = jsonMode(inv);
      if (json.enabled) {
        printJson({ projects: pickFields(rows as unknown as Record<string, unknown>[], json.fields) });
        return;
      }
      if (!rows.length) {
        console.log(`No projects you can open on ${target.host}`);
        return;
      }
      const width = Math.max(...rows.map((r) => r.collection.length + r.name.length + 1));
      for (const r of rows) {
        console.log(`${`${r.collection}/${r.name}`.padEnd(width)}  ${r.role.padEnd(5)}  ${r.private ? '' : 'public  '}${r.description}`.trimEnd());
      }
    },
  },
  {
    path: ['project', 'create'],
    summary: 'Create a private project holding a main.tex',
    description: `  ohagi project create alice/thesis --description "PhD thesis"

The collection may be one you own, or the one named after you, which is
created on the way if it does not exist yet.`,
    args: [{ name: 'project', required: true }],
    options: [
      { name: 'description', type: 'string', value: '<text>', summary: 'One line saying what it is' },
      JSON_OPTION,
      ...TARGET_OPTIONS,
    ],
    async run(inv) {
      const target = await targetFrom(inv);
      const p = projectArg(inv, 0);
      const data = await api(target, 'POST', '/api/projects', {
        collection: p.collection,
        name: p.project,
        description: inv.str('description') ?? undefined,
      });
      print(inv, data, () => console.log(`Created ${data.collection}/${data.name}: ${target.host}/${data.collection}/${data.name}`));
    },
  },
  {
    path: ['project', 'view'],
    summary: "Show a project's standing and files",
    args: [{ name: 'project', required: true }],
    options: [JSON_OPTION, ...TARGET_OPTIONS],
    async run(inv) {
      const target = await targetFrom(inv);
      const p = projectArg(inv, 0);
      const data = await api(target, 'GET', p.path);
      print(inv, data, () => {
        console.log(`${data.collection}/${data.name}${data.private ? '  (private)' : '  (public)'}`);
        if (data.description) console.log(`  ${data.description}`);
        console.log(`  your role: ${data.role}`);
        for (const f of (data.files ?? []) as { path: string; size: number; text: boolean }[]) {
          console.log(`  ${f.path}${f.text ? '' : '  (binary)'}`);
        }
      });
    },
  },
  {
    path: ['project', 'delete'],
    summary: 'Delete a project and everything in it (admin on the project)',
    args: [{ name: 'project', required: true }],
    options: [YES_OPTION, JSON_OPTION, ...TARGET_OPTIONS],
    async run(inv) {
      const p = projectArg(inv, 0);
      if (!inv.bool('yes')) throw new CliError(`Deleting ${p.collection}/${p.project} cannot be undone; pass --yes to confirm.`, EXIT_USAGE);
      const target = await targetFrom(inv);
      const data = await api(target, 'DELETE', `${p.path}?confirm=${encodeURIComponent(`${p.collection}/${p.project}`)}`);
      print(inv, data, () => console.log(`Deleted ${data.deleted}`));
    },
  },

  // ---- collaborators ----
  {
    path: ['collab', 'list'],
    summary: "List a project's collaborators and their roles",
    args: [{ name: 'project', required: true }],
    options: [JSON_OPTION, ...TARGET_OPTIONS],
    async run(inv) {
      const target = await targetFrom(inv);
      const p = projectArg(inv, 0);
      const data = await api(target, 'GET', `${p.path}/collaborators`);
      print(inv, data, () => {
        const rows = (data.collaborators ?? []) as { username: string; role: string }[];
        if (!rows.length) console.log('No collaborators.');
        for (const r of rows) console.log(`${r.username}  ${r.role}`);
        console.log(`Owners of ${p.collection} (admin without being listed): ${[p.collection, ...((data.owners ?? []) as string[])].join(', ')}`);
      });
    },
  },
  {
    path: ['collab', 'add'],
    summary: 'Give a user a role on a project',
    description: `read may open the project and follow along; write may also edit its files;
admin may also change its settings and who is on it.

  ohagi collab add alice/paper bob --role write`,
    args: [
      { name: 'project', required: true },
      { name: 'username', required: true },
    ],
    options: [
      { name: 'role', type: 'string', value: '<r>', summary: 'read, write (the default), or admin' },
      JSON_OPTION,
      ...TARGET_OPTIONS,
    ],
    async run(inv) {
      const target = await targetFrom(inv);
      const p = projectArg(inv, 0);
      const role = inv.str('role') ?? 'write';
      const data = await api(target, 'PUT', `${p.path}/collaborators/${encodeURIComponent(inv.args[1])}`, { role });
      print(inv, data, () => console.log(data.note ?? `${inv.args[1]} has the ${role} role on ${p.collection}/${p.project}`));
    },
  },
  {
    path: ['collab', 'remove'],
    summary: "Take a user off a project's collaborators",
    args: [
      { name: 'project', required: true },
      { name: 'username', required: true },
    ],
    options: [JSON_OPTION, ...TARGET_OPTIONS],
    async run(inv) {
      const target = await targetFrom(inv);
      const p = projectArg(inv, 0);
      const data = await api(target, 'DELETE', `${p.path}/collaborators/${encodeURIComponent(inv.args[1])}`);
      print(inv, data, () => console.log(`Removed ${inv.args[1]} from ${p.collection}/${p.project}`));
    },
  },

  // ---- files ----
  {
    path: ['file', 'get'],
    summary: "Copy a project's file to this machine",
    description: `  ohagi file get alice/paper main.tex            writes ./main.tex
  ohagi file get alice/paper figures/a.png -o -  writes it to stdout`,
    args: [
      { name: 'project', required: true },
      { name: 'path', required: true },
    ],
    options: [{ name: 'output', short: 'o', type: 'string', value: '<file>', summary: "Where to write it ('-' for stdout)" }, ...TARGET_OPTIONS],
    async run(inv) {
      const target = await targetFrom(inv);
      const p = projectArg(inv, 0);
      const r = await requestBytes(target, 'GET', `${p.path}/raw?path=${encodeURIComponent(inv.args[1])}`);
      if (!r.ok) {
        process.stderr.write(r.body.toString('utf8') + '\n');
        process.exit(exitCodeForStatus(r.status));
      }
      const out = inv.str('output') ?? path.basename(inv.args[1]);
      if (out === '-') process.stdout.write(r.body);
      else {
        fs.writeFileSync(out, r.body);
        console.log(`Wrote ${out} (${r.body.length} bytes)`);
      }
    },
  },
  {
    path: ['file', 'put'],
    summary: 'Copy a file from this machine into a project',
    description: `  ohagi file put alice/paper figure.png --as figures/figure.png

Someone editing the file sees its new text. A file that is already there is
replaced only with --overwrite.`,
    args: [
      { name: 'project', required: true },
      { name: 'local', required: true },
    ],
    options: [
      { name: 'as', type: 'string', value: '<path>', summary: 'Its path in the project (default: the local name)' },
      { name: 'overwrite', type: 'boolean', summary: 'Replace a file that is already there' },
      JSON_OPTION,
      ...TARGET_OPTIONS,
    ],
    async run(inv) {
      const target = await targetFrom(inv);
      const p = projectArg(inv, 0);
      const data = fs.readFileSync(inv.args[1]);
      const dest = inv.str('as') ?? path.basename(inv.args[1]);
      const q = `path=${encodeURIComponent(dest)}${inv.bool('overwrite') ? '&overwrite=1' : ''}`;
      const resp = await fetch(`${target.host}${p.path}/raw?${q}`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${target.token}`, 'content-type': 'application/octet-stream' },
        body: data,
      });
      const text = await resp.text();
      if (!resp.ok) {
        let message = text;
        try {
          message = JSON.parse(text).error ?? text;
        } catch {
          // not JSON; the text says it
        }
        throw new CliError(message, exitCodeForStatus(resp.status));
      }
      const out = JSON.parse(text) as Record<string, unknown>;
      print(inv, out, () => console.log(`Wrote ${p.collection}/${p.project}:${out.path} (${out.size} bytes)`));
    },
  },
  {
    path: ['file', 'rm'],
    summary: 'Delete a file from a project',
    args: [
      { name: 'project', required: true },
      { name: 'path', required: true },
    ],
    options: [JSON_OPTION, ...TARGET_OPTIONS],
    async run(inv) {
      const target = await targetFrom(inv);
      const p = projectArg(inv, 0);
      const data = await api(target, 'DELETE', `${p.path}/raw?path=${encodeURIComponent(inv.args[1])}`);
      print(inv, data, () => console.log(`Deleted ${data.deleted}`));
    },
  },
  {
    path: ['file', 'mv'],
    summary: 'Rename or move a file within a project',
    args: [
      { name: 'project', required: true },
      { name: 'from', required: true },
      { name: 'to', required: true },
    ],
    options: [JSON_OPTION, ...TARGET_OPTIONS],
    async run(inv) {
      const target = await targetFrom(inv);
      const p = projectArg(inv, 0);
      const data = await api(target, 'POST', `${p.path}/rename`, { from: inv.args[1], to: inv.args[2] });
      print(inv, data, () => console.log(`Renamed ${data.from} to ${data.to}`));
    },
  },

  // ---- compiling ----
  {
    path: ['compile'],
    summary: 'Compile a project to PDF, and optionally save it here',
    description: `  ohagi compile alice/paper              says how it went, and lists errors
  ohagi compile alice/paper -o paper.pdf  also writes the PDF

Exits non-zero when the compile has errors or produces no PDF.`,
    args: [{ name: 'project', required: true }],
    options: [
      { name: 'output', short: 'o', type: 'string', value: '<file>', summary: 'Write the PDF here' },
      { name: 'log', type: 'boolean', summary: 'Print the end of the log too' },
      JSON_OPTION,
      ...TARGET_OPTIONS,
    ],
    async run(inv) {
      const target = await targetFrom(inv);
      const p = projectArg(inv, 0);
      const r = await api(target, 'POST', `${p.path}/compile`, {});
      const errors = (r.errors ?? []) as { file: string | null; line: number | null; message: string }[];
      const json = jsonMode(inv);
      if (json.enabled) printJson(pickObject(r, json.fields));
      else {
        console.log(`${r.status === 'success' ? 'Compiled' : `Compile ${r.status}`}: ${p.collection}/${p.project} (${r.main || 'no main file'}) in ${((r.durationMs as number) / 1000).toFixed(1)} s, ${r.warnings} warning${r.warnings === 1 ? '' : 's'}`);
        for (const e of errors) console.log(`  ${e.file ? `${e.file}${e.line ? `:${e.line}` : ''}: ` : ''}${e.message}`);
        if (inv.bool('log')) console.log(String(r.log ?? ''));
      }
      const out = inv.str('output');
      if (out && r.pdf) {
        const pdf = await requestBytes(target, 'GET', `${p.path}/output.pdf`);
        if (!pdf.ok) throw new CliError('The PDF could not be fetched.', exitCodeForStatus(pdf.status));
        fs.writeFileSync(out, pdf.body);
        if (!json.enabled) console.log(`Wrote ${out}`);
      }
      if (r.status !== 'success' || !r.pdf) process.exitCode = 1;
    },
  },
];
