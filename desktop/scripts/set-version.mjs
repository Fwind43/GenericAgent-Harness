// Stamp one release version everywhere: node desktop/scripts/set-version.mjs v1.2.3
// (desktop/package.json, pyproject.toml, ga_harness/__init__.py). Used by CI on "v*" tags.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const version = (process.argv[2] || '').replace(/^v/, '');
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`usage: set-version.mjs vX.Y.Z[-pre] (got "${process.argv[2] || ''}")`);
  process.exit(1);
}
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function edit(rel, pattern, replacement) {
  const file = path.join(repo, rel);
  const text = fs.readFileSync(file, 'utf8');
  if (!pattern.test(text)) throw new Error(`no version field in ${rel}`);
  fs.writeFileSync(file, text.replace(pattern, replacement));
}

edit('desktop/package.json', /^(\s*"version":\s*")[^"]*(")/m, `$1${version}$2`);
edit('pyproject.toml', /^(version\s*=\s*")[^"]*(")/m, `$1${version}$2`);
edit('ga_harness/__init__.py', /^(__version__\s*=\s*["'])[^"']*(["'])/m, `$1${version}$2`);
console.log(`[set-version] ${version}`);
