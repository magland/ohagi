import { api } from '../../mochiforge/src/cli-api';
import { CliError, EXIT_USAGE } from '../../mochiforge/src/cli/exit';
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
];
