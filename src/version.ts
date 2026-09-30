import * as fs from 'fs';
import * as path from 'path';
import type { BuildInfo } from '../../mochiforge/src/version';

// What the page foot reports. mochi reads its own package.json from beside
// its compiled code, which in ohagi's dist is not there (dist/mochiforge has
// only code), so ohagi names its own: the version from ohagi's package.json,
// found from src/ under tsx or from dist/ohagi/src/ when built.

let cached: BuildInfo | null = null;

export function packageVersion(): string {
  return ohagiBuildInfo().version;
}

export function ohagiBuildInfo(): BuildInfo {
  if (cached) return cached;
  let version = 'latest';
  for (const p of [path.join(__dirname, '..', 'package.json'), path.join(__dirname, '..', '..', '..', 'package.json')]) {
    try {
      const pkg = JSON.parse(fs.readFileSync(p, 'utf8')) as { name?: string; version?: string };
      if (pkg.name === '@magland/ohagi' && typeof pkg.version === 'string') {
        version = pkg.version;
        break;
      }
    } catch {
      // try the next place
    }
  }
  cached = { version, commit: null, builtAt: null };
  return cached;
}
