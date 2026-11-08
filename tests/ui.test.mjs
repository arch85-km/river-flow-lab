// Browser checks for River Flood Lab, in headless Chromium.
//
// Serves the folder over http://127.0.0.1 and refuses every off-origin
// request, except map tiles and place search, which are answered from local
// fixtures and counted. Drives the page: views, flow, design elements,
// section editor, map drawing, exports, themes, and layout at four sizes.
//
// Usage: node tests/ui.test.mjs

import { createRequire } from 'node:module';
import http from 'node:http';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); }
catch { ({ chromium } = require('/opt/node22/lib/node_modules/playwright')); }

const html = readFileSync(new URL('../index.html', import.meta.url));
const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(html); }
  else { res.writeHead(404); res.end(); }
}).listen(0, '127.0.0.1');
await new Promise(r => server.once('listening', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const tilePng = readFileSync(new URL('./fixtures/tile.png', import.meta.url));
const waterways = readFileSync(new URL('./fixtures/overpass-waterways.json', import.meta.url), 'utf8');

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
}

// WebGL through SwiftShader, so the 3D view renders without a GPU.
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
async function openPage(size, scheme = 'light') {
  const ctx = await browser.newContext({ viewport: size, colorScheme: scheme, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [], offOrigin = [], tiles = [], searches = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.route('**/*', route => {
    const u = route.request().url();
    if (u.startsWith(origin) || u.startsWith('data:') || u.startsWith('blob:')) return route.continue();
    if (/^https:\/\/(tile\.openstreetmap\.org|tiles\.example\.org)\//.test(u)) { tiles.push(u); return route.fulfill({ status: 200, contentType: 'image/png', body: tilePng, headers: { 'access-control-allow-origin': '*' } }); }
    if (u.startsWith('https://nominatim.openstreetmap.org/')) { searches.push({ u, t: Date.now() }); return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify([{ lat: '53.3811', lon: '-1.4701', display_name: 'Sheffield, South Yorkshire, England' }]) }); }
    offOrigin.push(u); return route.abort();
  });
  await page.goto(origin + '/#advanced');
  await page.waitForFunction(() => window.RFL_UI && window.RFL_UI.result);
  // the rating curve is drawn after a short pause so the slider stays responsive
  await page.waitForFunction(() => document.querySelector('#rf-rc svg polyline'));
  return { page, ctx, errors, offOrigin, tiles, searches };
}
const ws = (page, x) => page.evaluate(x => { const r = window.RFL_UI.result; const s = r.sections; for (let i = 0; i < s.length - 1; i++) if (x <= s[i + 1].x) return s[i].ws + (s[i + 1].ws - s[i].ws) * (x - s[i].x) / (s[i + 1].x - s[i].x); return s[s.length - 1].ws; }, x);
const settle = page => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));

// ---- layout at four sizes, both themes ----
for (const scheme of ['light', 'dark']) {
  for (const size of [{ width: 1440, height: 900 }, { width: 1280, height: 820 }, { width: 900, height: 700 }, { width: 390, height: 844 }]) {
    const { page, ctx, errors, offOrigin, tiles } = await openPage(size, scheme);
    const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check(`${scheme} ${size.width}×${size.height}: no horizontal overflow`, over === 0, `${over}px`);
    const v3 = await page.evaluate(() => window.RFL_UI.view3d);
    check(`${scheme} ${size.width}: 3D view running`, v3.ok && v3.meshes > 5, JSON.stringify(v3));
    for (const v of ['plan', 'section', 'profile']) {
      await page.evaluate(v => window.RFL_UI.setView(v), v);
      const ok = await page.evaluate(v => { const h = document.querySelector(`.rf-view[data-view=${v}]`); const svg = h && h.querySelector('svg'); return !!svg && !h.hidden && svg.getBoundingClientRect().width > 250 && svg.querySelectorAll('polyline,polygon').length > 0; }, v);
      check(`${scheme} ${size.width}: ${v} view drawn`, ok);
    }
    await page.evaluate(() => window.RFL_UI.setView('3d'));
    const over2 = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check(`${scheme} ${size.width}: no overflow after switching views`, over2 === 0, `${over2}px`);
    check(`${scheme} ${size.width}: no console errors`, errors.length === 0, errors.join(' | '));
    check(`${scheme} ${size.width}: no off-origin requests`, offOrigin.length === 0, offOrigin.join(' '));
    check(`${scheme} ${size.width}: no map tiles until the Map view opens`, tiles.length === 0, `${tiles.length}`);
    await ctx.close();
  }
}

// ---- contrast of body text and buttons in both themes ----
for (const scheme of ['light', 'dark']) {
  const { page, ctx } = await openPage({ width: 1280, height: 820 }, scheme);
  const worst = await page.evaluate(() => {
    const lum = c => { const m = c.match(/[\d.]+/g).map(Number); const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(m[0]) + 0.7152 * f(m[1]) + 0.0722 * f(m[2]); };
    const bgOf = e => { while (e) { const b = getComputedStyle(e).backgroundColor; if (b && !/rgba\(.*, 0\)$/.test(b) && b !== 'transparent') return b; e = e.parentElement; } return 'rgb(255,255,255)'; };
    let worst = { r: 99 };
    for (const e of document.querySelectorAll('h1,p,label,button,td,th,summary,.rf-note,.rf-pill,.rf-eyebrow,.rf-tile b,.rf-foot span')) {
      if (!e.textContent.trim() || !e.getClientRects().length) continue;
      const a = lum(getComputedStyle(e).color), b = lum(bgOf(e));
      const r = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      if (r < worst.r) worst = { r, text: e.textContent.trim().slice(0, 40) };
    }
    return worst;
  });
  check(`${scheme}: text contrast at least 4.5:1`, worst.r >= 4.5, `worst ${worst.r.toFixed(2)} on “${worst.text}”`);
  await ctx.close();
}

// ---- interactions ----
const menu = async (page, id) => { await page.click('#rf-file-btn'); await page.click('#' + id); };
const download = async (page, id) => { const [dl] = await Promise.all([page.waitForEvent('download'), menu(page, id)]); return readFileSync(await dl.path()); };
const baseAt = (page, x) => page.evaluate(x => { const s = window.RFL_UI.base.sections; for (let i = 0; i < s.length - 1; i++) if (x <= s[i + 1].x) return s[i].ws + (s[i + 1].ws - s[i].ws) * (x - s[i].x) / (s[i + 1].x - s[i].x); return s[s.length - 1].ws; }, x);
{
  const { page, ctx, errors } = await openPage({ width: 1440, height: 900 });
  // open every folded section, as a student exploring would
  await page.evaluate(() => document.querySelectorAll('details.rf-sec, .rf-body details').forEach(d => { d.open = true; }));
  const st = await page.evaluate(() => ({ n: window.RFL_UI.state.sections.length, br: window.RFL_UI.state.bridges.length }));
  check('template reach loads with sections and the example bridge', st.n === 21 && st.br === 1, JSON.stringify(st));

  // view buttons
  for (const v of ['plan', 'section', 'profile', '3d']) {
    await page.click(`.rf-views [data-view="${v}"]`); await settle(page);
    check(`${v} button shows the ${v} view`, (await page.evaluate(() => window.RFL_UI.view)) === v && await page.locator(`.rf-view[data-view="${v}"]`).isVisible());
  }

  // flow
  const w0 = await ws(page, 150);
  await page.fill('#rf-q', '40'); await page.locator('#rf-q').blur(); await settle(page);
  const w1 = await ws(page, 150);
  check('more flow raises the water', w1 > w0 + 0.1, `${w0.toFixed(3)} → ${w1.toFixed(3)} m`);
  await page.locator('#rf-q-range').fill('900'); await settle(page);
  const q = await page.evaluate(() => window.RFL_UI.state.flow.Q);
  check('slider sets the flow', q > 40, `${q} m³/s`);
  check('flow pill follows the flow', (await page.textContent('#rf-pill-flow')).includes(q.toFixed(1)));

  // bankfull preset puts the water at the lower bank of the chosen section
  await page.selectOption('#rf-view-sec', 'XS11'); await settle(page);
  await page.click('[data-preset=bankfull]'); await settle(page);
  const bf = await page.evaluate(() => { const S = window.RFL_UI.state, r = window.RFL_UI.result, sec = S.sections.find(s => s.id === 'XS11');
    const g = y => { const p = sec.pts; for (let i = 0; i < p.length - 1; i++) if (y >= p[i][0] && y <= p[i + 1][0]) return p[i][1] + (p[i + 1][1] - p[i][1]) * (y - p[i][0]) / ((p[i + 1][0] - p[i][0]) || 1); };
    const bank = Math.min(g(sec.banks.left), g(sec.banks.right));
    const base = window.RFL_UI.base || r; const s = base.sections.find(q => q.id === 'XS11'); return { ws: s.ws, bank }; });
  check('bankfull preset fills to the lower bank (without design)', Math.abs(bf.ws - bf.bank) < 0.01, `water ${bf.ws.toFixed(3)} m, bank ${bf.bank.toFixed(3)} m`);
  await page.click('[data-preset=low]'); await settle(page);
  check('low preset is a quarter of bankfull', /bankfull/.test(await page.textContent('#rf-q-out')));
  await page.fill('#rf-q', '20'); await page.locator('#rf-q').blur(); await settle(page);

  // climate allowance
  const a0 = await ws(page, 200);
  await page.fill('#rf-allow', '30'); await page.locator('#rf-allow').blur(); await settle(page);
  const a1 = await ws(page, 200);
  check('climate allowance raises the water', a1 > a0, `+${((a1 - a0) * 1000).toFixed(0)} mm`);
  check('flow readout includes the allowance', (await page.textContent('#rf-q-out')).includes('+30%'));
  await page.fill('#rf-allow', '0'); await page.locator('#rf-allow').blur(); await settle(page);

  // results panel
  const status = await page.textContent('#rf-status');
  check('bridge note states the soffit clearance or pressure flow', /soffit/.test(status), status.slice(0, 120));
  check('afflux and Yarnell shown', /afflux/.test(status) && /Yarnell/.test(status));
  check('tiles show the chosen section', /Water level/i.test(await page.textContent('#rf-tiles')) && /XS11/.test(await page.textContent('#rf-at-head')));
  check('state pill names its verdict', /subcritical|chokes|Pressure|deck/.test(await page.textContent('#rf-pill-state')));

  // add an obstruction at the chosen section
  await page.selectOption('#rf-view-sec', 'XS15'); await settle(page);
  await page.click('[data-add=obstructions]'); await settle(page);
  const el = page.locator('details.rf-el[data-k=obstructions]').first();
  check('new element opens for editing', await el.evaluate(d => d.open));
  await el.locator('[data-f=wid]').fill('5.4'); await el.locator('[data-f=wid]').blur(); await settle(page);
  const after = await ws(page, 240), without = await baseAt(page, 240);
  check('obstruction raises the water upstream', after > without, `${after.toFixed(3)} m with it, ${without.toFixed(3)} m without`);
  await page.click('.rf-views [data-view="plan"]'); await settle(page);
  const eddies = await page.locator('#rf-plan polygon').count();
  check('eddy zones drawn in plan', eddies >= 2, `${eddies} polygons`);
  check('table shows change against no design', (await page.textContent('#rf-table')).includes('Change, m'));
  await page.uncheck('#rf-eddy-on'); await settle(page);
  check('turning eddy zones off removes them', (await page.locator('#rf-plan polygon').count()) === 0);
  await page.check('#rf-eddy-on'); await settle(page);

  // wall and building
  await page.click('[data-add=walls]'); await settle(page);
  await page.click('[data-add=buildings]'); await settle(page);
  const s2 = await page.textContent('#rf-status');
  check('building gets a floor-level verdict', /Building 1: (floor|.* of water over the floor)/.test(s2));
  check('element list holds all four', (await page.locator('details.rf-el').count()) === 4);
  await page.locator('details.rf-el[data-k=walls] > summary').click();
  await page.locator('details.rf-el[data-k=walls] [data-del]').click(); await settle(page);
  check('remove deletes the element', (await page.evaluate(() => window.RFL_UI.state.walls.length)) === 0);
  await page.click('[data-add=walls]'); await settle(page);

  // section editor validates
  await page.fill('#rf-sec-pts', '0 5\n10 x\n20 5');
  await page.click('#rf-sec-apply');
  check('editor refuses a bad line', /Line 2/.test(await page.textContent('#rf-sec-msg')));
  await page.fill('#rf-sec-pts', '0 5\n20 1\n10 5');
  await page.click('#rf-sec-apply');
  check('editor refuses offsets out of order', /left to right/.test(await page.textContent('#rf-sec-msg')));

  // exports from the File menu
  const text = (await download(page, 'rf-csv')).toString('utf8');
  check('CSV carries the caution', text.includes('not a flood risk assessment'));
  check('CSV carries the settings', /Flow [\d.]+ m3\/s/.test(text) && /eddy zones on/.test(text));
  check('CSV lists bridges and buildings', /\nbridge,/.test(text) && /\nbuilding,/.test(text));
  for (const v of ['plan', 'section', 'profile']) {
    await page.click(`.rf-views [data-view="${v}"]`); await settle(page);
    const buf = await download(page, 'rf-png');
    check(`${v} view exports as PNG`, buf.length > 5000 && buf[1] === 0x50, `${buf.length} bytes`);
  }
  await page.click('.rf-views [data-view="3d"]'); await settle(page);
  const b3 = await download(page, 'rf-png');
  check('3D view exports as PNG', b3.length > 20000 && b3[1] === 0x50, `${b3.length} bytes`);
  check('File menu closes after a choice', await page.locator('#rf-file-menu').isHidden());

  // save, new, reopen
  const [sv] = await Promise.all([page.waitForEvent('download'), menu(page, 'rf-save')]);
  const saved = JSON.parse(readFileSync(await sv.path(), 'utf8'));
  check('project saves design elements', saved.state.obstructions.length === 1 && saved.state.walls.length === 1 && saved.state.buildings.length === 1);
  await menu(page, 'rf-new'); await page.click('#rf-dlg-ok'); await settle(page);
  check('new reach clears design elements', (await page.evaluate(() => window.RFL_UI.state.obstructions.length + window.RFL_UI.state.bridges.length)) === 0);
  check('element list empties', (await page.locator('details.rf-el').count()) === 0);
  await page.setInputFiles('#rf-file', await sv.path()); await page.waitForFunction(() => window.RFL_UI.state.obstructions.length === 1);
  check('project reopens with its elements listed', (await page.locator('details.rf-el').count()) === 4);

  // 3D view
  const shot = await page.locator('#rf-3d').screenshot();
  check('3D canvas is not blank', shot.length > 20000, `${shot.length} bytes`);
  const m0 = (await page.evaluate(() => window.RFL_UI.view3d)).meshes;
  await page.click('[data-add=obstructions]'); await settle(page);
  const m1 = (await page.evaluate(() => window.RFL_UI.view3d)).meshes;
  check('adding an obstruction adds solids to the 3D view', m1 > m0, `${m0} → ${m1} objects`);
  await page.selectOption('#rf-vex', '10'); await settle(page);
  check('vertical exaggeration applies', (await page.evaluate(() => window.RFL_UI.view3d)).vex === 10);
  await page.click('#rf-3d-reset');
  const g0 = (await page.evaluate(() => window.RFL_UI.view3d)).geometries;
  for (let i = 0; i < 30; i++) await page.evaluate(i => { window.RFL_UI.state.flow.Q = 10 + i; window.RFL_UI.run(); }, i);
  await settle(page);
  const g1 = (await page.evaluate(() => window.RFL_UI.view3d)).geometries;
  check('30 rebuilds of the 3D view leak no geometry', g1 <= g0, `${g0} → ${g1} geometries held`);

  // theme switch
  await page.click('#rf-theme'); await page.click('#rf-theme');
  check('theme switches to dark', (await page.evaluate(() => document.documentElement.dataset.theme)) === 'dark');
  check('no console errors during interaction', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

// ---- map: drawing the river's course ----
{
  const { page, ctx, errors, tiles, searches } = await openPage({ width: 1440, height: 900 });
  await page.click('.rf-views [data-view="map"]'); await settle(page); await page.waitForTimeout(300);
  check('map: tiles load when the Map view opens', tiles.length > 0, `${tiles.length} tiles`);
  check('map: no more than 6 × 6 tiles on screen', tiles.length <= 36, `${tiles.length}`);
  check('map: OpenStreetMap credit shown', /© OpenStreetMap contributors/.test(await page.textContent('#rf-map-credit')));
  check('map: River section opens beside it', await page.locator('#rf-map-draw').isVisible());

  // typed coordinates go straight to the map, never to the geocoder
  await page.fill('#rf-map-q', '53.3626, -1.4721'); await page.click('#rf-map-go'); await settle(page);
  check('map: typed coordinates are not sent to Nominatim', searches.length === 0);
  check('map: typed coordinates are labelled', /53\.3626°N 1\.4721°W/.test(await page.textContent('#rf-map-msg')));
  // words do go to Nominatim, at most one request a second
  await page.fill('#rf-map-q', 'Sheffield'); await page.click('#rf-map-go');
  await page.waitForFunction(() => /Sheffield/.test(document.getElementById('rf-map-msg').textContent));
  await page.fill('#rf-map-q', 'Heeley'); await page.click('#rf-map-go');
  await page.waitForFunction(() => /Sheffield/.test(document.getElementById('rf-map-msg').textContent) && document.getElementById('rf-map-msg').textContent !== 'Searching…');
  await page.waitForTimeout(1300);
  check('map: place search asks Nominatim', searches.length === 2, `${searches.length} requests`);
  check('map: searches spaced at least 1.1 s apart', searches.length === 2 && searches[1].t - searches[0].t >= 1050, searches.length === 2 ? `${searches[1].t - searches[0].t} ms` : '');
  check('map: search credit shown', /Nominatim/.test(await page.textContent('#rf-map-credit')));
  await page.fill('#rf-map-q', '53.3626, -1.4721'); await page.click('#rf-map-go'); await settle(page);

  // draw an S-bend and build a reach from it
  await page.click('#rf-map-draw');
  check('map: drawing mode says what to do', /upstream to downstream/.test(await page.textContent('#rf-map-note')));
  const box = await page.locator('#rf-map').boundingBox();
  const clicks = [[0.18, 0.25], [0.35, 0.32], [0.48, 0.55], [0.6, 0.7], [0.78, 0.72], [0.9, 0.6]];
  for (const [fx, fy] of clicks) await page.mouse.click(box.x + fx * box.width, box.y + fy * box.height);
  check('map: each click adds a point', (await page.locator('#rf-map-svg circle').count()) === clicks.length);
  await page.click('#rf-map-undo');
  check('map: undo removes the last point', (await page.locator('#rf-map-svg circle').count()) === clicks.length - 1);
  await page.mouse.click(box.x + 0.9 * box.width, box.y + 0.6 * box.height);
  await page.click('#rf-map-build'); await settle(page);
  const built = await page.evaluate(() => { const S = window.RFL_UI.state; return { n: S.sections.length, geo: !!S.geo, name: S.name,
    bends: S.sections.filter(s => s.lengths && Math.abs(s.lengths.lob - s.lengths.rob) > 1).length, design: S.bridges.length + S.obstructions.length }; });
  check('map: a reach is built from the line', built.geo && built.n > 20, JSON.stringify(built));
  check('map: drawn reach is labelled as template levels', /template levels, not surveyed/.test(built.name));
  check('map: overbanks on a bend get their own reach lengths', built.bends > 5, `${built.bends} sections`);
  check('map: smoothing keeps the sections from crossing', !/cross/.test(await page.textContent('#rf-map-msg')), await page.textContent('#rf-map-msg'));
  check('map: section lines drawn on the map', (await page.locator('#rf-map-svg polyline').count()) > built.n);
  check('map: drawing mode ends after building', (await page.getAttribute('#rf-map-draw', 'aria-pressed')) === 'false');
  // a click near a section line chooses it
  const target = await page.evaluate(() => { const r = window.RFL_UI.result; return r.sections[5].id; });
  await page.evaluate(id => window.RFL_UI.setView('map'), target);
  const pt = await page.evaluate(id => window.RFL_UI.screenOf(id), target);
  await page.mouse.click(box.x + pt[0], box.y + pt[1]); await settle(page);
  check('map: clicking a section chooses it', (await page.inputValue('#rf-view-sec')) === target, `${await page.inputValue('#rf-view-sec')} vs ${target}`);
  await page.click('.rf-views [data-view="3d"]'); await settle(page);
  const v3m = await page.evaluate(() => window.RFL_UI.view3d);
  // a straight 51 m-wide reach spans about 51 m across; the drawn S-bend spans far more
  check('map: 3D view follows the drawn river', v3m.ok && v3m.span && Math.min(...v3m.span) > 150, JSON.stringify(v3m));
  await page.click('[data-add=bridges]'); await settle(page);
  check('map: design elements work on a drawn river', (await page.textContent('#rf-status')).includes('soffit'));

  // a drawn river survives save and reopen
  const [sv] = await Promise.all([page.waitForEvent('download'), menu(page, 'rf-save')]);
  await menu(page, 'rf-new'); await page.click('#rf-dlg-ok'); await settle(page);
  check('map: a new template reach clears the drawn river', (await page.evaluate(() => window.RFL_UI.state.geo)) === null);
  await page.setInputFiles('#rf-file', await sv.path()); await page.waitForFunction(() => !!window.RFL_UI.state.geo);
  check('map: a drawn river reopens from its project file', true);

  // custom tile service: validated, and its credit is required
  await page.click('.rf-views [data-view="map"]'); await settle(page);
  await page.evaluate(() => document.querySelectorAll('#rf-river-sec details').forEach(d => { d.open = true; }));
  const tryService = async (url, credit) => { await page.fill('#rf-tiles-url', url); await page.fill('#rf-tiles-credit', credit); await page.click('#rf-tiles-save'); return page.textContent('#rf-tiles-msg'); };
  check('tiles: refuses http', /https/.test(await tryService('http://tiles.example.org/{z}/{x}/{y}.png', '© Example')));
  check('tiles: refuses an address without {x}', /\{z\}, \{x\} and \{y\}/.test(await tryService('https://tiles.example.org/{z}/{y}.png', '© Example')));
  check('tiles: refuses a service without a credit line', /credit line is required/.test(await tryService('https://tiles.example.org/{z}/{x}/{y}.png', '')));
  const before = tiles.length;
  check('tiles: accepts a valid service', /Saved/.test(await tryService('https://tiles.example.org/{z}/{x}/{y}.png', '© Example Tiles')));
  await settle(page); await page.waitForTimeout(200);
  check('tiles: the custom service is used', tiles.slice(before).some(u => u.startsWith('https://tiles.example.org/')));
  check('tiles: its credit is shown', /© Example Tiles/.test(await page.textContent('#rf-map-credit')));
  await page.click('#rf-tiles-reset'); await settle(page);
  check('tiles: reset returns to OpenStreetMap', /© OpenStreetMap contributors/.test(await page.textContent('#rf-map-credit')));
  check('map: no console errors', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

// ---- rivers from OpenStreetMap (Overpass answered from a synthetic fixture) ----
{
  const { page, ctx, errors, offOrigin } = await openPage({ width: 1440, height: 900 });
  const asked = [];
  const answer = (status, body) => route => { asked.push(new URL(route.request().url()).host + ' ' + status); return route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body }); };
  // first server busy, the second answers: the retry rule
  await page.route('https://overpass-api.de/**', answer(504, 'busy'));
  await page.route('https://overpass.private.coffee/**', answer(200, waterways));
  await page.click('.rf-views [data-view="map"]'); await settle(page);
  await page.click('#rf-map-osm');
  await page.waitForFunction(() => window.RFL_UI.rivers, null, { timeout: 20000 });
  check('rivers: the proxy is tried first, then the servers directly', asked.length === 2 && asked[0] === 'overpass-api.de 504' && asked[1] === 'overpass.private.coffee 200', asked.join(', '));
  const rivers = await page.evaluate(() => window.RFL_UI.rivers);
  check('rivers: the two ways of the River Sheaf are joined end to start', rivers[0].name === 'River Sheaf' && rivers[0].points === 5, JSON.stringify(rivers[0]));
  check('rivers: a culverted part is noted', rivers[0].culvert === true);
  check('rivers: the stream is listed too', rivers.some(r => r.name === 'Meers Brook' && r.kind === 'stream'));
  check('rivers: the panel names what was found', /River Sheaf \(river\), Meers Brook \(stream\)/.test(await page.textContent('#rf-map-msg')));
  check('rivers: OpenStreetMap credited under ODbL on the map', /Rivers © OpenStreetMap contributors, ODbL/.test(await page.textContent('#rf-map-credit')));
  // choose the Sheaf, then click the reach's ends in the downstream-first order
  const box = await page.locator('#rf-map').boundingBox();
  const at = async f => { const p = await page.evaluate(f => window.RFL_UI.chainScreen(0, f), f); await page.mouse.click(box.x + p[0], box.y + p[1]); };
  await at(0.5);
  check('rivers: clicking a river chooses it', /River Sheaf \(river\), \d+ m in view/.test(await page.textContent('#rf-map-msg')));
  await at(0.7); await at(0.3);
  check('rivers: the part between the two clicks becomes the line', /taken from OpenStreetMap, upstream end first/.test(await page.textContent('#rf-map-msg')));
  await page.fill('#rf-map-spacing', '10');
  await page.click('#rf-map-build'); await settle(page);
  const g = await page.evaluate(() => { const S = window.RFL_UI.state; return { name: S.name, osm: S.geo && S.geo.osm, first: S.geo.line[0], last: S.geo.line[S.geo.line.length - 1], n: S.sections.length }; });
  check('rivers: the reach is named after the river and its source', /^River Sheaf \(line from OpenStreetMap; template levels, not surveyed\)$/.test(g.name), g.name);
  // the Sheaf flows north in the fixture: chainage 0 (downstream) must be the northern end, whatever order the ends were clicked
  check('rivers: OpenStreetMap\'s direction of flow sets which end is downstream', g.first[0] > g.last[0], `downstream ${g.first[0].toFixed(4)}°N, upstream ${g.last[0].toFixed(4)}°N`);
  check('rivers: sections are cut along it', g.n > 15, `${g.n} sections`);
  const cul = await page.evaluate(() => window.RFL_UI.state.geo.culverts);
  check('rivers: the culverted part of the reach is located by chainage', cul.length === 1 && cul[0][0] === 0 && cul[0][1] > 50, JSON.stringify(cul));
  check('rivers: a culvert in the reach is reported, with what to do', /in a culvert at 0–\d+ m.*bridge with its soffit at the culvert roof/.test(await page.textContent('#rf-status')));
  const csvText = (await download(page, 'rf-csv')).toString('utf8');
  check('rivers: every export credits the river line under ODbL', /River line © OpenStreetMap contributors, ODbL/.test(csvText));
  const png = await download(page, 'rf-png');
  check('rivers: the Map view exports as PNG, with the credit row', png.length > 20000 && png[1] === 0x50, `${png.length} bytes`);

  // a runtime-error answer is a busy server, not an empty map
  asked.length = 0;
  await page.unroute('https://overpass-api.de/**'); await page.unroute('https://overpass.private.coffee/**');
  await page.route('https://overpass-api.de/**', answer(200, JSON.stringify({ elements: [], remark: 'runtime error: Query timed out in "query" at line 1 after 26 seconds.' })));
  await page.route('https://overpass.private.coffee/**', answer(200, waterways));
  await page.evaluate(() => window.RFL_UI.setView('map'));
  await page.click('#rf-map-osm');
  await page.waitForFunction(() => window.RFL_UI.rivers, null, { timeout: 20000 });
  check('rivers: a "runtime error" answer is retried on the other server', asked.length === 2 && asked[1] === 'overpass.private.coffee 200', asked.join(', '));

  // this site's proxy answering: the public servers are not asked at all
  asked.length = 0;
  await page.route(origin + '/overpass-proxy.php?**', route => { asked.push('proxy'); return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'X-Overpass-Cache': 'hit' }, body: waterways }); });
  const fresh = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const p2 = await fresh.newPage();
  const direct = [];
  await p2.route('**/*', route => {
    const u = route.request().url();
    if (u.startsWith(origin + '/overpass-proxy.php')) { direct.push('proxy'); return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'X-Overpass-Cache': 'hit' }, body: waterways }); }
    if (u.startsWith(origin)) return route.continue();
    if (/tile\.openstreetmap\.org/.test(u)) return route.fulfill({ status: 200, contentType: 'image/png', body: tilePng });
    direct.push(new URL(u).host); return route.abort();
  });
  await p2.goto(origin + '/'); await p2.waitForFunction(() => window.RFL_UI && window.RFL_UI.result);
  await p2.click('.rf-views [data-view="map"]'); await p2.click('#rf-map-osm');
  await p2.waitForFunction(() => window.RFL_UI.rivers, null, { timeout: 20000 });
  check('rivers: with this site\'s proxy installed, only the proxy is asked', direct.length === 1 && direct[0] === 'proxy', direct.join(', '));
  await fresh.close();

  // too large a view: asked to zoom in, nothing requested
  asked.length = 0;
  for (let i = 0; i < 3; i++) await page.click('#rf-map-out');
  await page.click('#rf-map-osm'); await settle(page);
  check('rivers: a view over 3 km asks to zoom in and requests nothing', /Zoom in/.test(await page.textContent('#rf-map-msg')) && asked.length === 0, await page.textContent('#rf-map-msg'));

  // all servers refuse: the message says so, and drawing by hand still works
  for (let i = 0; i < 3; i++) await page.click('#rf-map-in');
  await page.unroute('https://overpass-api.de/**'); await page.unroute('https://overpass.private.coffee/**');
  await page.route('https://overpass-api.de/**', answer(400, 'bad'));
  await page.route('https://overpass.private.coffee/**', answer(400, 'bad'));
  await page.click('#rf-map-osm');
  await page.waitForFunction(() => /Could not fetch/.test(document.getElementById('rf-map-msg').textContent), null, { timeout: 20000 });
  check('rivers: two refusals end in a message that offers drawing by hand', /draw the river by hand/.test(await page.textContent('#rf-map-msg')));
  check('rivers: the old rivers are cleared when a load starts', (await page.evaluate(() => window.RFL_UI.rivers)) === null);
  // the 404, 504 and 400s are the failures this block simulates
  const real = errors.filter(e => !/Failed to load resource/.test(e));
  check('rivers: no console errors beyond the simulated failures', real.length === 0, real.join(' | '));
  await ctx.close();
}

// ---- map: tiles that fail say why ----
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 } });
  const page = await ctx.newPage();
  await page.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
  await page.goto(origin + '/#advanced'); await page.waitForFunction(() => window.RFL_UI && window.RFL_UI.result);
  await page.click('.rf-views [data-view="map"]'); await page.waitForTimeout(500);
  check('map: failed tiles show the failure hint', /did not load/.test(await page.textContent('#rf-map-note')));
  await ctx.close();
}

// ---- phone: the view on top, controls or results beneath ----
{
  const { page, ctx, errors } = await openPage({ width: 390, height: 844 });
  const stageH = await page.evaluate(() => document.querySelector('.rf-stage').getBoundingClientRect().height);
  check('phone: the view takes the top of the screen', stageH > 400, `${Math.round(stageH)} px`);
  for (const v of ['3d', 'map', 'plan', 'section', 'profile']) check(`phone: ${v} button visible`, await page.locator(`.rf-views [data-view="${v}"]`).isVisible());
  check('phone: controls shown first', await page.locator('.rf-left').isVisible() && await page.locator('.rf-right').isHidden());
  await page.click('.rf-drawers [data-drawer=results]');
  check('phone: Results swaps in the results panel', await page.locator('.rf-right').isVisible() && await page.locator('.rf-left').isHidden());
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check('phone: no overflow with results open', over === 0, `${over}px`);
  check('phone: no console errors', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

await browser.close(); server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
