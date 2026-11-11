// Proves each check in tools/check-release-metadata.mjs by breaking it: the
// release files are copied to a temporary folder, one mistake is made, and the
// guard must fail on exactly the check that mistake belongs to. A correctly
// stamped 1.0.0 release must pass every check.
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILES = ['CITATION.cff', '.zenodo.json', 'package.json', 'package-lock.json', 'index.html', 'docs/method-notes.html', 'docs/method-notes-summary.html'];
const NOTES = FILES.slice(-2);
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); };

function run(edit) {
  const dir = mkdtempSync(join(tmpdir(), 'rfl-guard-'));
  mkdirSync(join(dir, 'docs'));
  const files = Object.fromEntries(FILES.map(f => [f, readFileSync(join(ROOT, f), 'utf8')]));
  edit(files);
  for (const [f, t] of Object.entries(files)) writeFileSync(join(dir, f), t);
  const r = spawnSync(process.execPath, [join(ROOT, 'tools/check-release-metadata.mjs')], { env: { ...process.env, RFL_RELEASE_ROOT: dir }, encoding: 'utf8' });
  rmSync(dir, { recursive: true, force: true });
  return { code: r.status, failed: r.stdout.split('\n').filter(l => l.includes('FAIL')).map(l => l.replace(/^\s*FAIL\s+/, '')) };
}
const sub = (files, f, a, b) => { if (!files[f].includes(a)) throw new Error(`${f} has no "${a}"`); files[f] = files[f].split(a).join(b); };
const json = (files, f, fn) => { const j = JSON.parse(files[f]); fn(j); files[f] = JSON.stringify(j, null, 2); };

// What a correct 1.0.0 release looks like, released 1 December 2026 with
// concept DOI 10.5281/zenodo.100 and version DOI 10.5281/zenodo.101.
function release(files, { versionDoi = true } = {}) {
  sub(files, 'CITATION.cff', 'version: 0.1.0', 'version: 1.0.0\ndate-released: 2026-12-01\ndoi: 10.5281/zenodo.100\nidentifiers:\n  - type: doi\n    value: 10.5281/zenodo.100\n    description: "Concept DOI — always resolves to the latest version"' +
    (versionDoi ? '\n  - type: doi\n    value: 10.5281/zenodo.101\n    description: "Version DOI — 1.0.0; cite this when quoting a figure"' : ''));
  json(files, '.zenodo.json', j => { j.version = '1.0.0'; });
  json(files, 'package.json', j => { j.version = '1.0.0'; });
  json(files, 'package-lock.json', j => { j.version = '1.0.0'; j.packages[''].version = '1.0.0'; });
  sub(files, 'index.html', "VERSION = '0.1.0'", "VERSION = '1.0.0'");
  sub(files, 'index.html', 'const RELEASED = null;', "const RELEASED = '2026-12-01';");
  const doi = versionDoi ? '10.5281/zenodo.101' : '10.5281/zenodo.100';
  sub(files, 'index.html', "'}'].join('\\n');", `'  doi     = {${doi}},', '}'].join('\\n');`);
  for (const f of NOTES) {
    sub(files, f, '0.1.0 &middot; in development', '1.0.0 &middot; 1 December 2026');
    sub(files, f, '(Version 0.1.0)', '(Version 1.0.0)');
    sub(files, f, 'version   = {0.1.0},', `version   = {1.0.0},\n  doi       = {${doi}},`);
  }
}

const now = run(() => {});
check('the files as they stand pass the guard', now.code === 0, now.failed.join(' | '));
const rel = run(f => release(f));
check('a correctly stamped 1.0.0 release passes every check', rel.code === 0, rel.failed.join(' | '));
const relConcept = run(f => release(f, { versionDoi: false }));
check('a release citing the concept DOI before its version DOI is minted passes', relConcept.code === 0, relConcept.failed.join(' | '));

// [what goes wrong, the check that must catch it, the mistake]
const BREAKS = [
  ['.zenodo.json left on an old version', 'every file names the same version', f => json(f, '.zenodo.json', j => { j.version = '0.0.9'; })],
  ['package-lock.json left on an old version', 'every file names the same version', f => json(f, 'package-lock.json', j => { j.version = '0.0.9'; })],
  ["the app's VERSION left behind", 'every file names the same version', f => sub(f, 'index.html', "VERSION = '0.1.0'", "VERSION = '0.0.9'")],
  ['a release date that is not a date', 'date-released is a date', f => sub(f, 'CITATION.cff', 'version: 0.1.0', 'version: 0.1.0\ndate-released: December 2026')],
  ['a release date in CITATION.cff but not in the app', "RELEASED agrees with CITATION.cff", f => sub(f, 'CITATION.cff', 'version: 0.1.0', 'version: 0.1.0\ndate-released: 2026-12-01')],
  ['RELEASED removed from the app', "RELEASED agrees with CITATION.cff", f => sub(f, 'index.html', 'const RELEASED = null;', '')],
  ['.zenodo.json with another title', '.zenodo.json names the title', f => json(f, '.zenodo.json', j => { j.title = 'River Flow Lab'; })],
  ["the app's citation with another title", "the app's citation names the title", f => sub(f, 'index.html', "const TITLE = 'River Flow Lab: A browser-based", "const TITLE = 'River Flow Lab: An interactive")],
  ["the app linking the old repository", "the app's citation links the repository", f => sub(f, 'index.html', "const REPO = 'https://github.com/arch85-km/river-flow-lab'", "const REPO = 'https://github.com/arch85-km/river-flood-lab'")],
  ['a DOI before a release date', 'a DOI only once released', f => sub(f, 'CITATION.cff', 'version: 0.1.0', 'version: 0.1.0\ndoi: 10.5281/zenodo.100')],
  ['the © card citing a DOI before one exists', '© card cites no DOI before one exists', f => sub(f, 'index.html', "'}'].join('\\n');", "'  doi     = {10.5281/zenodo.999},', '}'].join('\\n');")],
  ['the full notes on an old version', 'method-notes.html byline names', f => sub(f, NOTES[0], '0.1.0 &middot; in development', '0.0.9 &middot; in development')],
  ['the short notes dated though unreleased', 'method-notes-summary.html byline reads', f => sub(f, NOTES[1], '0.1.0 &middot; in development', '0.1.0 &middot; 1 December 2026')],
  ['the APA citation on an old version', 'method-notes.html APA citation names', f => sub(f, NOTES[0], '(Version 0.1.0)', '(Version 0.0.9)')],
  ['the BibTeX on an old version', 'method-notes-summary.html BibTeX names', f => sub(f, NOTES[1], 'version   = {0.1.0},', 'version   = {0.0.9},')],
  ['the notes citing another title', 'method-notes.html cites the title', f => sub(f, NOTES[0], 'title     = {River Flow Lab: A browser-based', 'title     = {River Flow Lab: An interactive')],
  ['the notes linking the old repository', 'method-notes-summary.html links the repository', f => sub(f, NOTES[1], 'arch85-km/river-flow-lab', 'arch85-km/river-flood-lab')],
  ['the notes citing a DOI before one exists', 'method-notes.html cites no DOI before one exists', f => sub(f, NOTES[0], 'version   = {0.1.0},', 'version   = {0.1.0},\n  doi       = {10.5281/zenodo.999},')],
  ['a release with the notes still citing no DOI', "method-notes.html cites this release's version DOI", f => { release(f); sub(f, NOTES[0], '  doi       = {10.5281/zenodo.101},\n', ''); }],
  ['a release with the notes citing the concept DOI once the version DOI exists', "method-notes-summary.html cites this release's version DOI", f => { release(f); sub(f, NOTES[1], 'doi       = {10.5281/zenodo.101}', 'doi       = {10.5281/zenodo.100}'); }],
  ['a release with the notes still "in development"', 'method-notes.html byline reads "1 December 2026"', f => { release(f); sub(f, NOTES[0], '1.0.0 &middot; 1 December 2026', '1.0.0 &middot; in development'); }],
  ['a release with the © card citing no DOI', "© card cites a DOI CITATION.cff declares", f => { release(f); sub(f, 'index.html', "'  doi     = {10.5281/zenodo.101},', ", ''); }],
];
for (const [what, expect, edit] of BREAKS) {
  const r = run(edit);
  check(`caught: ${what}`, r.code === 1 && r.failed.some(l => l.includes(expect)), r.failed.join(' | ') || 'guard passed');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
