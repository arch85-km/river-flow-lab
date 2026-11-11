#!/usr/bin/env node
/**
 * Release-metadata consistency, after Solar Analysis Lab's guard.
 *
 * The version, the release date, the title, the repository and the DOI are
 * written in several places that nothing builds from and no other test reads,
 * so they drift silently. .zenodo.json is the dangerous one: Zenodo's GitHub
 * integration reads it in preference to the release tag and to CITATION.cff,
 * so a stale version there publishes the archive under the wrong label with a
 * correct new DOI, a failure that looks like success.
 *
 * Before the first release CITATION.cff has no date-released and no DOI, the
 * app's RELEASED is null, and the method notes say "in development" and carry
 * no DOI. From the first release on, all of them must name the same date and
 * cite a DOI that CITATION.cff declares.
 *
 * Dependency-free: node tools/check-release-metadata.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.RFL_RELEASE_ROOT || join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  —  ' + detail : ''}`);
};
const read = p => readFileSync(join(ROOT, p), 'utf8');
const unq = s => (s || '').trim().replace(/^["']|["']$/g, '');
const field = (text, key) => unq((text.match(new RegExp(`^${key}:[ \\t]*(.+)$`, 'm')) || [])[1]) || null;

const cff = read('CITATION.cff');
const zen = JSON.parse(read('.zenodo.json'));
const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));
const app = read('index.html');
const DOCS = ['docs/method-notes.html', 'docs/method-notes-summary.html'];
const docs = Object.fromEntries(DOCS.map(d => [d, read(d)]));

/* --- the version -------------------------------------------------------- */
const versions = {
  'CITATION.cff': field(cff, 'version'),
  '.zenodo.json': zen.version,
  'package.json': pkg.version,
  'package-lock.json': lock.version,
  'index.html VERSION': (app.match(/VERSION = '([^']+)'/) || [])[1],
};
const distinct = [...new Set(Object.values(versions))];
ok('every file names the same version', distinct.length === 1 && !!distinct[0],
  Object.entries(versions).map(([k, v]) => `${k} ${v}`).join(' · '));
const VERSION = versions['CITATION.cff'];

/* --- the release date ---------------------------------------------------- */
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];
const DATE = field(cff, 'date-released');
const longDate = iso => { const d = new Date(iso + 'T00:00:00Z'); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
const releasedRaw = (app.match(/const RELEASED = (null|'[^']*');/) || [])[1];
const RELEASED = releasedRaw === 'null' ? null : unq(releasedRaw);
ok('CITATION.cff date-released is a date, or absent before the first release',
  DATE === null || /^\d{4}-\d{2}-\d{2}$/.test(DATE), DATE || 'not released yet');
ok("index.html's RELEASED agrees with CITATION.cff", releasedRaw !== undefined && RELEASED === DATE,
  `index.html ${RELEASED}, CITATION.cff ${DATE}`);

/* --- the title ------------------------------------------------------------ */
const TITLE = field(cff, 'title');
ok('.zenodo.json names the title CITATION.cff declares', zen.title === TITLE, zen.title);
ok("the app's citation names the title CITATION.cff declares",
  (app.match(/const TITLE = '([^']+)'/) || [])[1] === TITLE);

/* --- the repository ------------------------------------------------------ */
const REPO = field(cff, 'repository-code');
ok("the app's citation links the repository CITATION.cff declares",
  (app.match(/const REPO = '([^']+)'/) || [])[1] === REPO, REPO);

/* --- the DOI -------------------------------------------------------------- */
const CONCEPT = field(cff, 'doi');
const declared = [...cff.matchAll(/10\.5281\/zenodo\.\d+/g)].map(m => m[0]);
const ids = [...cff.matchAll(/value:[ \t]*"?(10\.5281\/zenodo\.\d+)"?\s*\n\s*description:[ \t]*"?([^"\n]*?)"?[ \t]*$/gm)].map(m => ({ doi: m[1], desc: m[2] }));
const verRe = new RegExp('version doi\\s*[\\u2014-]\\s*' + String(VERSION).replace(/\./g, '\\.') + '(?!\\d)', 'i');
const VERSION_DOI = (ids.find(e => verRe.test(e.desc)) || {}).doi || null;
ok('a DOI only once released', !CONCEPT || !!DATE, CONCEPT ? `concept ${CONCEPT}` : 'no DOI yet');
if (CONCEPT) ok("the app's © card cites a DOI CITATION.cff declares", declared.some(d => app.includes(d)));
else ok("the app's © card cites no DOI before one exists", !/10\.5281\/zenodo/.test(app));

/* --- the method notes ----------------------------------------------------- */
for (const [doc, html] of Object.entries(docs)) {
  const byline = (html.match(/<b>Version<\/b>\s*([0-9][0-9.]*)\s*(?:&middot;|·)\s*([^<]+)</) || []);
  ok(`${doc} byline names ${VERSION}`, byline[1] === VERSION, `byline ${byline[1]}`);
  const want = DATE ? longDate(DATE) : 'in development';
  ok(`${doc} byline reads "${want}"`, (byline[2] || '').trim() === want, `byline "${(byline[2] || '').trim()}"`);
  ok(`${doc} APA citation names ${VERSION}`, html.includes(`(Version ${VERSION}) [Computer software]`));
  ok(`${doc} BibTeX names ${VERSION}`, new RegExp(`version\\s*=\\s*\\{${VERSION.replace(/\./g, '\\.')}\\}`).test(html));
  const flat = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  ok(`${doc} cites the title CITATION.cff declares`, flat.includes(TITLE) && html.includes(`title     = {${TITLE}}`));
  ok(`${doc} links the repository`, html.includes(REPO));
  const bibDoi = (html.match(/doi\s*=\s*\{([^}]+)\}/) || [])[1];
  if (CONCEPT) {
    const wanted = VERSION_DOI || CONCEPT;
    ok(`${doc} cites ${VERSION_DOI ? "this release's version DOI" : 'the concept DOI, as it must until a version DOI is minted'}`,
      !!bibDoi && bibDoi.trim() === wanted, `BibTeX doi ${bibDoi}, wanted ${wanted}`);
  } else {
    ok(`${doc} cites no DOI before one exists`, !bibDoi && !/10\.5281\/zenodo/.test(html));
  }
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
