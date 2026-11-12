// Proves each check in tools/check-release-metadata.mjs by breaking it: the
// release files are copied to a temporary folder, put into a known state, one
// mistake is made, and the guard must fail on exactly the check that mistake
// belongs to. Correct states must pass every check.
//
// It reads the version and date from the files rather than assuming them, so it
// works before a release, after one and once Zenodo's DOIs are recorded: each
// case first puts the files into either the unreleased state (no date, no DOI)
// or a released one (a version, a date, and DOIs when asked for).
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
const re = (files, f, pattern, b) => { if (!pattern.test(files[f])) throw new Error(`${f} has no ${pattern}`); files[f] = files[f].replace(pattern, b); };
const json = (files, f, fn) => { const j = JSON.parse(files[f]); fn(j); files[f] = JSON.stringify(j, null, 2); };
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const longDate = iso => { const d = new Date(iso + 'T00:00:00Z'); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
const BIB_END = "'}'].join('\\n');";   // the end of the © card's BibTeX lines in index.html

// The version the files carry now.
const V = readFileSync(join(ROOT, 'CITATION.cff'), 'utf8').match(/^version:[ \t]*"?([^"\s]+)/m)[1];

// The unreleased state: the current version, no date, no DOI anywhere.
function unreleased(f) {
  f['CITATION.cff'] = f['CITATION.cff'].replace(/^date-released:.*\n/m, '').replace(/^doi:.*\n/m, '').replace(/^identifiers:\n(?:[ \t]+.*\n)*/m, '');
  re(f, 'index.html', /const RELEASED = (?:null|'[^']*');/, 'const RELEASED = null;');
  f['index.html'] = f['index.html'].replace(/'  doi     = \{[^}]*\},', /g, '');
  for (const n of NOTES) {
    re(f, n, /(<b>Version<\/b>\s*[0-9.]+\s*&middot;\s*)[^<]+/, '$1in development');
    f[n] = f[n].replace(/\n  doi       = \{[^}]*\},/g, '');
  }
}
// A released state: from unreleased, version `to` on date `date`, with a concept
// DOI (and a version DOI when versionDoi) recorded and cited.
function released(f, { to = '9.9.9', date = '2026-12-01', concept = false, versionDoi = false } = {}) {
  unreleased(f);
  const ids = concept ? `doi: 10.5281/zenodo.100\nidentifiers:\n  - type: doi\n    value: 10.5281/zenodo.100\n    description: "Concept DOI — always resolves to the latest version"` +
    (versionDoi ? `\n  - type: doi\n    value: 10.5281/zenodo.101\n    description: "Version DOI — ${to}; cite this when quoting a figure"` : '') + '\n' : '';
  re(f, 'CITATION.cff', /^version:.*\n/m, `version: ${to}\ndate-released: ${date}\n${ids}`);
  json(f, '.zenodo.json', j => { j.version = to; });
  json(f, 'package.json', j => { j.version = to; });
  json(f, 'package-lock.json', j => { j.version = to; j.packages[''].version = to; });
  sub(f, 'index.html', `VERSION = '${V}'`, `VERSION = '${to}'`);
  sub(f, 'index.html', 'const RELEASED = null;', `const RELEASED = '${date}';`);
  const doi = versionDoi ? '10.5281/zenodo.101' : '10.5281/zenodo.100';
  if (concept) sub(f, 'index.html', BIB_END, `'  doi     = {${doi}},', ${BIB_END}`);
  for (const n of NOTES) {
    sub(f, n, `${V} &middot; in development`, `${to} &middot; ${longDate(date)}`);
    sub(f, n, `(Version ${V})`, `(Version ${to})`);
    sub(f, n, `version   = {${V}},`, `version   = {${to}},` + (concept ? `\n  doi       = {${doi}},` : ''));
  }
}

// ---- correct states pass ----
for (const [what, edit] of [
  ['the files as they stand', () => {}],
  ['the unreleased state', unreleased],
  ['a release with no DOI yet', f => released(f)],
  ['a release citing the concept DOI before its version DOI is minted', f => released(f, { concept: true })],
  ['a release citing its version DOI', f => released(f, { concept: true, versionDoi: true })],
]) {
  const r = run(edit);
  check(`passes: ${what}`, r.code === 0, r.failed.join(' | '));
}

// ---- each mistake is caught by its own check ----
// [what goes wrong, the check that must catch it, the mistake]
const BREAKS = [
  ['.zenodo.json left on an old version', 'every file names the same version', f => { released(f); json(f, '.zenodo.json', j => { j.version = '0.0.9'; }); }],
  ['package-lock.json left on an old version', 'every file names the same version', f => { released(f); json(f, 'package-lock.json', j => { j.version = '0.0.9'; }); }],
  ["the app's VERSION left behind", 'every file names the same version', f => { released(f); sub(f, 'index.html', "VERSION = '9.9.9'", "VERSION = '0.0.9'"); }],
  ['a release date that is not a date', 'date-released is a date', f => { released(f); sub(f, 'CITATION.cff', 'date-released: 2026-12-01', 'date-released: December 2026'); }],
  ['a release date in CITATION.cff but not in the app', 'RELEASED agrees with CITATION.cff', f => { unreleased(f); re(f, 'CITATION.cff', /^version:.*\n/m, `version: ${V}\ndate-released: 2026-12-01\n`); }],
  ['the app released on another day', 'RELEASED agrees with CITATION.cff', f => { released(f); sub(f, 'index.html', "const RELEASED = '2026-12-01';", "const RELEASED = '2026-12-02';"); }],
  ['RELEASED removed from the app', 'RELEASED agrees with CITATION.cff', f => { released(f); sub(f, 'index.html', "const RELEASED = '2026-12-01';", ''); }],
  ['.zenodo.json with another title', '.zenodo.json names the title', f => json(f, '.zenodo.json', j => { j.title = 'River Flow Lab'; })],
  ["the app's citation with another title", "the app's citation names the title", f => sub(f, 'index.html', "const TITLE = 'River Flow Lab: An interactive", "const TITLE = 'River Flow Lab: A browser-based")],
  ['the app linking the old repository', "the app's citation links the repository", f => sub(f, 'index.html', "const REPO = 'https://github.com/arch85-km/river-flow-lab'", "const REPO = 'https://github.com/arch85-km/river-flood-lab'")],
  ['a DOI before a release date', 'a DOI only once released', f => { unreleased(f); re(f, 'CITATION.cff', /^version:.*\n/m, `version: ${V}\ndoi: 10.5281/zenodo.100\n`); }],
  ['the © card citing a DOI before one exists', '© card cites no DOI before one exists', f => { released(f); sub(f, 'index.html', BIB_END, `'  doi     = {10.5281/zenodo.999},', ${BIB_END}`); }],
  ['the full notes on an old version', 'method-notes.html byline names', f => { released(f); sub(f, NOTES[0], '9.9.9 &middot;', '0.0.9 &middot;'); }],
  ['the short notes dated though unreleased', 'method-notes-summary.html byline reads', f => { unreleased(f); sub(f, NOTES[1], `${V} &middot; in development`, `${V} &middot; 1 December 2026`); }],
  ['the notes still "in development" after the release', 'method-notes.html byline reads "1 December 2026"', f => { released(f); sub(f, NOTES[0], '9.9.9 &middot; 1 December 2026', '9.9.9 &middot; in development'); }],
  ['the notes dated another day', 'method-notes-summary.html byline reads "1 December 2026"', f => { released(f); sub(f, NOTES[1], '9.9.9 &middot; 1 December 2026', '9.9.9 &middot; 2 December 2026'); }],
  ['the APA citation on an old version', 'method-notes.html APA citation names', f => { released(f); sub(f, NOTES[0], '(Version 9.9.9)', '(Version 0.0.9)'); }],
  ['the BibTeX on an old version', 'method-notes-summary.html BibTeX names', f => { released(f); sub(f, NOTES[1], 'version   = {9.9.9},', 'version   = {0.0.9},'); }],
  ['the notes citing another title', 'method-notes.html cites the title', f => sub(f, NOTES[0], 'title     = {River Flow Lab: An interactive', 'title     = {River Flow Lab: A browser-based')],
  ['the notes linking the old repository', 'method-notes-summary.html links the repository', f => sub(f, NOTES[1], 'arch85-km/river-flow-lab', 'arch85-km/river-flood-lab')],
  ['the notes citing a DOI before one exists', 'method-notes.html cites no DOI before one exists', f => { released(f); sub(f, NOTES[0], 'version   = {9.9.9},', 'version   = {9.9.9},\n  doi       = {10.5281/zenodo.999},'); }],
  ['DOIs recorded but the notes citing none', "method-notes.html cites this release's version DOI", f => { released(f, { concept: true, versionDoi: true }); sub(f, NOTES[0], '\n  doi       = {10.5281/zenodo.101},', ''); }],
  ['the notes citing the concept DOI once the version DOI exists', "method-notes-summary.html cites this release's version DOI", f => { released(f, { concept: true, versionDoi: true }); sub(f, NOTES[1], 'doi       = {10.5281/zenodo.101}', 'doi       = {10.5281/zenodo.100}'); }],
  ['DOIs recorded but the © card citing none', '© card cites a DOI CITATION.cff declares', f => { released(f, { concept: true, versionDoi: true }); sub(f, 'index.html', "'  doi     = {10.5281/zenodo.101},', ", ''); }],
];
for (const [what, expect, edit] of BREAKS) {
  const r = run(edit);
  check(`caught: ${what}`, r.code === 1 && r.failed.some(l => l.includes(expect)), r.failed.join(' | ') || 'guard passed');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
