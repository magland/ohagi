import { setNaming } from '../../mochiforge/src/naming';
import { MARK, WORDMARK } from './logo';
import { ohagiBuildInfo } from './version';

// ohagi is built on mochiforge's modules, imported directly from the sibling
// checkout as dango's are, and this is where it tells them its own name.
// Importing this file is the whole mechanism: every entry point imports it
// before anything else, and the shared modules read these values at call
// time, so an ohagi process mints ohagi_ tokens, sets an ohagi_session
// cookie, keeps its identity in shelf.json, and draws its own logo in the
// forge's page layout.

setNaming({
  product: 'ohagi',
  tokenPrefix: 'ohagi_',
  cookieName: 'ohagi_session',
  stateFile: 'shelf.json',
  rootNoun: 'shelf',
  envPrefix: 'OHAGI',
  configDirName: 'ohagi',
  displayName: 'ohagi',
  git: false,
  accessFile: 'access.json',
  itemNoun: 'project',
  itemNounPlural: 'projects',
  adminSections: ['users', 'github', 'appearance'],
  jumpGroup: 'Projects',
  wordmark: WORDMARK,
  mark: MARK,
  buildInfo: ohagiBuildInfo,
});
