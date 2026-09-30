import { Express, Request, Response } from 'express';
import { advertiseGitService, checkCreds, runGitService } from '../../mochiforge/src/githttp';
import { AuthLimiter, createGate } from '../../mochiforge/src/limit';
import { loadConfig } from '../../mochiforge/src/config';
import { History, repoDir } from './history';
import { findProject, projectRole } from './projects';

// git clone of a project, over smart HTTP, at the project's own address as a
// repository's is in a vault: git clone https://<shelf>/<collection>/<project>.
// Fetching only; the shelf is where the files are edited, so a push is
// refused with a sentence saying so.
//
// Every request needs a credential, the username and token as git sends them
// (Basic auth), checked by mochi's own rule and throttled by mochi's limiter,
// and the read role on the project. A project the credential cannot see
// answers as an absent one does. Before refs are advertised the project is
// committed, so a clone has what the editors show at that moment.

export function registerGitHttp(app: Express, root: string, limiter: AuthLimiter, history: History): void {
  // mochi's clone gate, sized by the same setting: at most this many clones
  // run at once, the rest wait briefly and then are told the server is busy.
  const gate = createGate({ concurrency: loadConfig(root).limits.clone, queue: 16, timeoutMs: 10000 });

  function deny(res: Response, status: number, message: string, retryAfter?: number) {
    if (status === 401) res.setHeader('WWW-Authenticate', 'Basic realm="ohagi"');
    if (retryAfter !== undefined) res.setHeader('Retry-After', String(retryAfter));
    res.status(status).type('text/plain').send(message + '\n');
  }

  function readable(req: Request, res: Response) {
    const checked = checkCreds(root, limiter, req, 'clone');
    if ('ok' in checked) {
      deny(res, checked.status, checked.message, checked.retryAfter);
      return null;
    }
    const ref = findProject(root, req.params.collection, req.params.project);
    if (!ref || projectRole(root, checked.auth, ref) === null) {
      deny(res, 404, 'project not found');
      return null;
    }
    return ref;
  }

  app.get('/:collection/:project/info/refs', async (req, res, next) => {
    try {
      if (req.query.service === 'git-receive-pack') {
        deny(res, 403, 'this is read-only: edit the project on the shelf, and pull to get the changes');
        return;
      }
      if (req.query.service !== 'git-upload-pack') {
        deny(res, 403, 'unsupported service');
        return;
      }
      const ref = readable(req, res);
      if (!ref) return;
      await history.commitNow(ref);
      await advertiseGitService(req, res, 'git-upload-pack', repoDir(ref), gate);
    } catch (e) {
      next(e);
    }
  });

  app.post('/:collection/:project/git-upload-pack', async (req, res, next) => {
    try {
      const ref = readable(req, res);
      if (!ref) return;
      await runGitService(req, res, 'git-upload-pack', repoDir(ref), gate);
    } catch (e) {
      next(e);
    }
  });

  app.post('/:collection/:project/git-receive-pack', (_req, res) => {
    deny(res, 403, 'this is read-only: edit the project on the shelf, and pull to get the changes');
  });
}
