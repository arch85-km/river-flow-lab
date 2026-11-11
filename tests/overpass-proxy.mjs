#!/usr/bin/env node
/**
 * Checks for server/overpass-proxy.php, run against PHP's built-in server and a
 * stand-in for the Overpass servers, so nothing leaves the machine. Ported
 * from Solar Analysis Lab's checks for its buildings proxy.
 *
 *   node tests/overpass-proxy.mjs
 *
 * Skipped, not failed, where PHP is not installed.
 */
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, utimesSync, rmSync } from 'node:fs';
import { createHash, createHmac } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0, failed = 0;
function check(name, ok, detail = ''){
  if (ok) passed++; else failed++;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail ? '  — ' + detail : ''));
}

console.log('\n=== OpenStreetMap waterways proxy (server/overpass-proxy.php) ===');
if (spawnSync('php', ['-v']).status !== 0){
  console.log('  SKIP  PHP is not installed here');
  process.exit(0);
}

/* ── a stand-in for the three Overpass servers ─────────────────────────── */

// mode per server: 'ok', 'busy' (504), 'remark' (200 with a runtime error),
// 'slow' (ok after 600 ms)
const mode = { u1: 'ok', u2: 'ok', u3: 'ok' };
const hits = { u1: 0, u2: 0, u3: 0 };
let lastQuery = '';
const ELEMENTS = [{ type: 'way', id: 1, tags: { waterway: 'river', name: 'River Sheaf' },
  geometry: [{ lat: 53.38, lon: -1.47 }, { lat: 53.38, lon: -1.4699 }, { lat: 53.3801, lon: -1.4699 }, { lat: 53.38, lon: -1.47 }] }];
const upstream = createServer((req, res) => {
  const which = req.url.slice(1);
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    hits[which] = (hits[which] || 0) + 1;
    lastQuery = decodeURIComponent(body.replace(/^data=/, ''));
    const m = mode[which];
    const ok = () => { res.writeHead(200, { 'Content-Type': 'application/json' });
                       res.end(JSON.stringify({ version: 0.6, elements: ELEMENTS })); };
    if (m === 'busy'){ res.writeHead(504); res.end('busy'); }
    else if (m === 'remark'){ res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ version: 0.6, elements: [], remark: 'runtime error: Query timed out in "query" at line 1 after 26 seconds.' })); }
    else if (m === 'slow') setTimeout(ok, 600);
    else ok();
  });
});
await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
const UP = 'http://127.0.0.1:' + upstream.address().port;

/* ── the proxy, pointed at the stand-in ────────────────────────────────── */

const dir = mkdtempSync(join(tmpdir(), 'overpass-proxy-'));
let php = readFileSync(join(ROOT, 'server', 'overpass-proxy.php'), 'utf8');
const swap = (from, to) => {
  if (php.split(from).length !== 2) throw new Error('expected one ' + from.slice(0, 40));
  php = php.replace(from, to);
};
swap(`$UPSTREAMS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
    'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];`, `$UPSTREAMS = ['${UP}/u1', '${UP}/u2', '${UP}/u3'];`);
swap('$SERVER_TIMEOUT = 30;', '$SERVER_TIMEOUT = 5;');
// The hour's visitor counts go to a folder of the test's own, to be inspected
const LIMITS = join(dir, 'limits');
mkdirSync(LIMITS);
swap('$LIMIT_DIR = sys_get_temp_dir();', '$LIMIT_DIR = ' + JSON.stringify(LIMITS) + ';');
writeFileSync(join(dir, 'overpass-proxy.php'), php);
// A second copy with a tiny cache ceiling and a folder of its own, to see the
// oldest answers go when a new one takes the folder past it
writeFileSync(join(dir, 'overpass-proxy-cap.php'),
  php.replace('$CACHE_MAX_MB = 200;', '$CACHE_MAX_MB = 0.002;')
     .replace("$CACHE_DIR = __DIR__ . '/overpass-cache';", "$CACHE_DIR = __DIR__ . '/overpass-cache-cap';"));

const port = 20000 + Math.floor(Math.random() * 20000);
const server = spawn('php', ['-S', '127.0.0.1:' + port, '-t', dir],
                     { env: { ...process.env, PHP_CLI_SERVER_WORKERS: '6' }, stdio: 'ignore' });
const BASE = 'http://127.0.0.1:' + port;
for (let i = 0; i < 50; i++){
  try { await fetch(BASE + '/'); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
}

const PAGE = BASE + '/index.html';
const ask = (bbox, headers = { Referer: PAGE }) =>
  fetch(BASE + '/overpass-proxy.php?bbox=' + bbox, { headers })
    .then(async (r) => ({ status: r.status, cache: r.headers.get('x-overpass-cache'),
                          age: +r.headers.get('x-overpass-age'), body: await r.text() }));
const reset = () => { for (const k of Object.keys(hits)) hits[k] = 0; };
const BOX = '53.378203,-1.473010,53.381797,-1.466990';

try {
  // Not from the page: refused, so the script is not an open relay
  const bare = await ask(BOX, {});
  const elsewhere = await ask(BOX, { Referer: 'https://example.org/page' });
  check('a request not from a page on this site is refused',
        bare.status === 403 && elsewhere.status === 403,
        'no referer ' + bare.status + ', another site ' + elsewhere.status);

  // Only a box, never a query
  const notBox = await ask('way["waterway"]');
  const huge = await ask('53.000000,-1.500000,53.100000,-1.400000');
  check('only a small box is accepted, never a query',
        notBox.status === 400 && huge.status === 400, 'query ' + notBox.status + ', 11 km box ' + huge.status);
  const reach = await ask('53.350000,-1.490000,53.375000,-1.450000');
  check('a 2.8 km box, the size a river reach needs, is accepted', reach.status === 200, 'status ' + reach.status);

  // First ask: the main server busy, the second answers
  reset(); mode.u1 = 'busy';
  const first = await ask(BOX);
  check('a busy server is skipped and the next one supplies the rivers',
        first.status === 200 && first.cache === 'miss' && hits.u1 === 1 && hits.u2 === 1 &&
        JSON.parse(first.body).elements.length === 1,
        'status ' + first.status + ', cache ' + first.cache + ', asked u1 ' + hits.u1 + ' u2 ' + hits.u2);
  check('the query sent is waterways in that box, written by the proxy',
        lastQuery.includes('(' + BOX + ')') && /way\["waterway"~"\^\(river\|stream\|canal\|drain\|ditch\)\$"\]/.test(lastQuery) &&
        !/building/.test(lastQuery) && /out geom/.test(lastQuery), lastQuery);

  // Second ask: from the cache, Overpass not asked at all
  reset(); mode.u1 = 'ok';
  const second = await ask(BOX);
  check('asking again is answered from the cache, without asking Overpass',
        second.status === 200 && second.cache === 'hit' && hits.u1 + hits.u2 + hits.u3 === 0,
        'cache ' + second.cache + ', upstream requests ' + (hits.u1 + hits.u2 + hits.u3));

  // A runtime-error remark is a failure, not an empty map
  reset(); mode.u1 = 'remark';
  const BOX2 = '53.370000,-1.480000,53.373594,-1.473980';
  const remark = await ask(BOX2);
  check('a "runtime error" answer is not kept; the next server is asked',
        remark.status === 200 && JSON.parse(remark.body).elements.length === 1 && hits.u2 === 1,
        'asked u1 ' + hits.u1 + ', u2 ' + hits.u2);

  // Every server down, nothing cached: a busy status, not an empty answer
  reset(); mode.u1 = mode.u2 = mode.u3 = 'busy';
  const BOX3 = '51.500000,-0.130000,51.503594,-0.124230';
  const down = await ask(BOX3);
  check('with every server down and nothing kept, it says busy (503)',
        down.status === 503 && hits.u1 === 1 && hits.u2 === 1 && hits.u3 === 1,
        'status ' + down.status + ', each server asked once');

  // Every server down, an old answer kept: the old answer, marked stale
  const kept = readdirSync(join(dir, 'overpass-cache')).find((f) => f.endsWith('.php'));
  const old = (Date.now() / 1000) - 40 * 86400;
  for (const f of readdirSync(join(dir, 'overpass-cache')).filter((f) => f.endsWith('.php')))
    utimesSync(join(dir, 'overpass-cache', f), old, old);
  reset();
  const stale = await ask(BOX);
  check('with every server down, an answer older than 30 days is served, marked stale',
        stale.status === 200 && stale.cache === 'stale' && stale.age > 39 * 86400 && !!kept,
        'cache ' + stale.cache + ', ' + Math.round(stale.age / 86400) + ' days old');

  // A class at once: one request to Overpass
  reset(); mode.u1 = 'slow'; mode.u2 = mode.u3 = 'ok';
  const BOX4 = '55.950000,-3.190000,55.953594,-3.183570';
  const many = await Promise.all(Array.from({ length: 5 }, () => ask(BOX4)));
  check('five visitors asking for the same place at once cost one request to Overpass',
        many.every((r) => r.status === 200) && hits.u1 === 1 && hits.u2 === 0,
        many.map((r) => r.cache).join(', ') + '; Overpass asked ' + (hits.u1 + hits.u2 + hits.u3) + '×');

  // The cache folder is closed to the web
  check('the cache folder is closed to direct browsing',
        existsSync(join(dir, 'overpass-cache', '.htaccess')) &&
        /Require all denied/.test(readFileSync(join(dir, 'overpass-cache', '.htaccess'), 'utf8')));

  // Reported from the live site: SiteGround serves a plain .json file directly,
  // .htaccess or not, so a kept answer was downloadable by its name. Each is now
  // a .php file whose first line ends a direct request with nothing.
  const kept2 = readdirSync(join(dir, 'overpass-cache'));
  const direct = await fetch(BASE + '/overpass-cache/' + kept2.find((f) => f.endsWith('.php')));
  const directBody = await direct.text();
  check('a kept answer cannot be downloaded directly, even where .htaccess is ignored',
        !kept2.some((f) => f.endsWith('.json')) && kept2.some((f) => f.endsWith('.php')) &&
        direct.status === 404 && !directBody.includes('elements'),
        'files ' + [...new Set(kept2.map((f) => f.split('.').pop()))].join('/') +
        '; a direct request gets ' + direct.status + ', ' + directBody.length + ' bytes');

  // The visitor counts: filed under a keyed hash, never the address or a
  // plain hash of it, and deleted when their hour is over
  const IP = '127.0.0.1';
  let names = readdirSync(LIMITS);
  const keyName = names.find((f) => /-key$/.test(f)) || '';
  const hour = (keyName.match(/^riverflowlab-overpass-(\d{10})-key$/) || [])[1] || '';
  const counts = names.filter((f) => f.endsWith('.cnt') && !f.endsWith('-all.cnt'));
  const plain = [IP, createHash('sha1').update(IP).digest('hex'), createHash('sha256').update(IP).digest('hex')];
  check('a visitor\'s count is filed under a keyed hash, not the address or a plain hash of it',
        !!hour && counts.length === 1 && names.every((f) => plain.every((x) => !f.includes(x))),
        names.length + ' files this hour: ' + names.map((f) => f.replace(/[0-9a-f]{40,}/, '…')).join(', '));

  // Files from an earlier hour, including the first version's plain-hash name
  const was = ['riverflowlab-overpass-2000010100-key', 'riverflowlab-overpass-2000010100-' + 'a'.repeat(64) + '.cnt',
               'riverflowlab-overpass-2000010100-' + plain[1] + '.cnt'];
  for (const f of was) writeFileSync(join(LIMITS, f), '1');
  const hit = await ask(BOX4);                    // answered from the cache
  names = readdirSync(LIMITS);
  check('counts and keys from an earlier hour are deleted by the next request, even a cached one',
        hit.cache === 'hit' && was.every((f) => !names.includes(f)) && names.includes(keyName),
        'cache ' + hit.cache + '; ' + was.filter((f) => names.includes(f)).length + ' of ' + was.length +
        ' earlier-hour files left, ' + names.length + ' file(s) in all');

  // The limit still applies: this visitor's count, set to the hour's maximum
  const key = readFileSync(join(LIMITS, keyName));
  const mine = 'riverflowlab-overpass-' + hour + '-' + createHmac('sha256', key).update(IP).digest('hex') + '.cnt';
  writeFileSync(join(LIMITS, mine), '300');
  reset(); mode.u1 = mode.u2 = mode.u3 = 'ok';
  const over = await ask('48.850000,2.340000,48.853594,2.345470');
  check('a visitor past 300 fetches in the hour is refused, and Overpass is not asked',
        over.status === 429 && hits.u1 + hits.u2 + hits.u3 === 0,
        'status ' + over.status + ', Overpass asked ' + (hits.u1 + hits.u2 + hits.u3) + '×');

  // The whole site's ceiling: past it, nothing new is fetched for anyone, and
  // what is already kept is still served
  for (const f of readdirSync(LIMITS)) if (f.endsWith('.cnt')) rmSync(join(LIMITS, f));
  writeFileSync(join(LIMITS, 'riverflowlab-overpass-' + hour + '-all.cnt'), '1000');
  reset();
  const capped = await ask('48.870000,2.340000,48.873594,2.345470');
  const keptStill = await ask(BOX4);
  check('past 1,000 fetches in the hour for the whole site, nothing new is fetched; kept answers still are served',
        capped.status === 429 && hits.u1 + hits.u2 + hits.u3 === 0 && keptStill.status === 200 && keptStill.cache === 'hit',
        'new box ' + capped.status + ', Overpass asked ' + (hits.u1 + hits.u2 + hits.u3) + '×; a kept box ' + keptStill.cache);

  // A new hour, a new key: its first fetch makes one
  for (const f of readdirSync(LIMITS)) rmSync(join(LIMITS, f));
  const fresh = await ask('48.860000,2.340000,48.863594,2.345470');
  const key2 = readFileSync(join(LIMITS, keyName));
  check('the key is random and made afresh: a new hour\'s key differs from the last',
        fresh.status === 200 && key2.length === 32 && !key2.equals(key),
        '32 random bytes, different from the previous key');

  // The cache ceiling (about 2 KB in this copy): three old answers are planted,
  // a fourth is fetched, and the oldest go first until the folder is under it
  for (const f of readdirSync(LIMITS)) rmSync(join(LIMITS, f));
  const CAP = join(dir, 'overpass-cache-cap');
  mkdirSync(CAP, { recursive: true });
  const G = '<?php http_response_code(404); exit; ?>\n', pad = (n) => JSON.stringify({ elements: [], pad: 'x'.repeat(n) });
  const planted = ['a', 'b', 'c'].map((n, i) => {
    const f = join(CAP, n.repeat(40) + '.php');
    writeFileSync(f, G + pad(700));
    const t = Date.now() / 1000 - (3 - i) * 3600;  // a oldest, then b, then c
    utimesSync(f, t, t);
    return f;
  });
  const capAsk = await fetch(BASE + '/overpass-proxy-cap.php?bbox=48.880000,2.340000,48.883594,2.345470', { headers: { Referer: PAGE } });
  const left = readdirSync(CAP).filter((f) => f.endsWith('.php'));
  let bytes = 0; for (const f of left) bytes += readFileSync(join(CAP, f)).length;
  check('past the cache ceiling the oldest answers are removed first, and the new one is kept',
        capAsk.status === 200 && !existsSync(planted[0]) && existsSync(planted[2]) && left.length >= 2 && bytes <= 0.002 * 1048576,
        'kept ' + left.length + ' answers, ' + bytes + ' bytes against a ' + Math.round(0.002 * 1048576) +
        '-byte ceiling; the oldest ' + (existsSync(planted[0]) ? 'still there' : 'gone'));

  // A POST is not how the page asks
  const post = await fetch(BASE + '/overpass-proxy.php?bbox=' + BOX, { method: 'POST', headers: { Referer: PAGE } });
  check('only GET is answered', post.status === 405, 'POST ' + post.status);
} finally {
  server.kill();
  upstream.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
