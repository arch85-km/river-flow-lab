// Browser checks for River Flow Lab, in headless Chromium.
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
  const path = req.url.split('?')[0];
  if (path === '/' || path === '/index.html') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(html); }
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
  await page.goto(origin + '/?tour=0#advanced');
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
  {
    // the readout spells out the sum, so the box and the modelled flow cannot look as if they disagree
    const out = await page.textContent('#rf-q-out'), Q = await page.evaluate(() => window.RFL_UI.state.flow.Q);
    const qf = v => v < 10 ? v.toFixed(2) : v.toFixed(1);
    check('flow readout spells out set flow + allowance = modelled flow', out.includes(`${qf(Q)} m³/s + 30% climate allowance = ${qf(Q * 1.3)} m³/s modelled`), out);
  }
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
  // the flow-direction arrow is a polygon too, so count only the eddy zones
  const eddies = await page.locator('#rf-plan polygon:not(.rf-flow)').count();
  check('eddy zones drawn in plan', eddies >= 2, `${eddies} polygons`);
  check('table shows change against no design', (await page.textContent('#rf-table')).includes('Change, m'));
  await page.uncheck('#rf-eddy-on'); await settle(page);
  check('turning eddy zones off removes them', (await page.locator('#rf-plan polygon:not(.rf-flow)').count()) === 0);
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
  // a blank field is refused, not read as 0
  const before05 = await page.evaluate(() => { const u = window.RFL_UI, s = u.state.sections[0]; return { left: s.banks.left, x: s.x }; });
  await page.selectOption('#rf-sec-pick', { index: 0 });
  const blLeft = await page.inputValue('#rf-sec-bl'), secX = await page.inputValue('#rf-sec-x');
  await page.fill('#rf-sec-bl', '');
  await page.click('#rf-sec-apply');
  const leftAfter = await page.evaluate(() => window.RFL_UI.state.sections[0].banks.left);
  check('editor refuses a blank bank', /Banks must/.test(await page.textContent('#rf-sec-msg')) && leftAfter === before05.left, `left bank ${leftAfter}`);
  await page.fill('#rf-sec-bl', blLeft);
  await page.fill('#rf-sec-x', '');
  await page.click('#rf-sec-apply');
  check('editor refuses a blank chainage', /Chainage must/.test(await page.textContent('#rf-sec-msg')));
  await page.fill('#rf-sec-x', secX);
  const basicPanel = await page.evaluate(() => { const root = document.getElementById('rf-root'), was = root.dataset.level; root.dataset.level = 'basic'; const shown = document.getElementById('rf-sec-pts').closest('details').offsetParent !== null; root.dataset.level = was; return shown; });
  check('the section editor is for Advanced only', basicPanel === false);
  await page.fill('#rf-sec-pts', '0 5\n10 x\n20 5');
  await page.click('#rf-sec-apply');
  check('editor refuses a bad line', /Line 2/.test(await page.textContent('#rf-sec-msg')));
  await page.fill('#rf-sec-pts', '0 5\n20 1\n10 5');
  await page.click('#rf-sec-apply');
  check('editor refuses offsets out of order', /left to right/.test(await page.textContent('#rf-sec-msg')));

  // distances on the ground, and which grid a terrain file is in
  const geo = await page.evaluate(() => {
    const t = window.RFL_UI.terrain, tile = (x0, y0, grid) => ({ nx: 3, ny: 3, cell: 1, x0, y0, z: new Float32Array(9).fill(10), grid });
    const flat = { at: () => 10, georef: false, fine: true };
    const eastWest = t.terrainReach(flat, [[400000, 386000], [402000, 386000]], { half: 50, spacing: 100, depth: 1, bed: 5, side: 1, carve: true, measures: [] });
    const northSouth = t.geoFrame({ line: [[53, -1.5], [53 + 1000 / 111286, -1.5]], yc: 0 }).length;
    const eastDrawn = t.geoFrame({ line: [[53, -1.5], [53, -1.5 + 1000 / 67137]], yc: 0 }).length;
    const tags = code => t.gridFromTiffTags ? t.gridFromTiffTags({ 34735: [1, 1, 0, 1, 3072, 0, 1, code] }) : null;
    const citation = t.gridFromTiffTags ? t.gridFromTiffTags({ 34735: [1, 1, 0, 1, 3072, 0, 1, 32767], 34737: 'OSGB 1936 / British National Grid|' }) : null;
    const none = t.gridFromTiffTags ? t.gridFromTiffTags({}) : null;
    const utm = t.gridTerrain([tile(430000, 5900000, 'unknown')]), plain = t.gridTerrain([tile(430000, 386000, 'unknown')]), said = t.gridTerrain([tile(430000, 386000, 'other')]);
    return { eastWest: eastWest.sections[eastWest.sections.length - 1].x, northSouth, eastDrawn, bng: tags(27700), compound: tags(7405), other: tags(32630), citation, none,
      utmGeoref: utm.georef, utmGrid: utm.grid, plainGeoref: plain.georef, plainGrid: plain.grid, saidGeoref: said.georef };
  });
  check('a 2 km east-west BNG line measures 2 km', Math.abs(geo.eastWest - 2000) < 1, `${geo.eastWest} m`);
  check('1 km north at 53 degrees measures 1 km', Math.abs(geo.northSouth - 1000) < 1, `${geo.northSouth.toFixed(1)} m`);
  check('1 km east at 53 degrees measures 1 km', Math.abs(geo.eastDrawn - 1000) < 1, `${geo.eastDrawn.toFixed(1)} m`);
  check('a GeoTIFF declared as British National Grid is read as that', geo.bng === 'bng' && geo.compound === 'bng' && geo.citation === 'bng', JSON.stringify([geo.bng, geo.compound, geo.citation]));
  check('a GeoTIFF in another grid is recognised', geo.other === 'other', String(geo.other));
  check('a GeoTIFF that names no grid is unknown', geo.none === 'unknown', String(geo.none));
  check('terrain outside the British National Grid range is not placed as BNG', geo.utmGeoref === false && geo.utmGrid === 'other', `${geo.utmGeoref} ${geo.utmGrid}`);
  check('a declared other grid is not placed as BNG', geo.saidGeoref === false);
  check('an undeclared grid in range is assumed to be BNG and says so', geo.plainGeoref === true && geo.plainGrid === 'unknown', `${geo.plainGeoref} ${geo.plainGrid}`);

  // terrain with no data along the river itself, as where LIDAR masks the water
  const gap = await page.evaluate(() => {
    const t = window.RFL_UI.terrain, at = (e, n) => Math.abs(n - 386000) < 3 ? null : 10 + Math.abs(n - 386000) * 0.05;
    const T = { at, georef: true, fine: true }, line = [[400000, 386000], [400400, 386000]];
    const p = carve => ({ half: 50, spacing: 50, depth: 1, bed: 5, side: 1, carve, measures: [] });
    let carved = null, own = null, thrown = '';
    try { carved = t.terrainReach(T, line, p(true)); own = t.terrainReach(T, line, p(false)); } catch (e) { thrown = String(e); }
    const span = r => r && r.sections ? Math.min(...r.sections.map(s => s.pts[s.pts.length - 1][0] - s.pts[0][0])) : null;
    return { thrown, carvedSpan: span(carved), ownAnswer: !!own && (!!own.sections || !!own.error), ownError: own && own.error };
  });
  check('terrain with no data at the river keeps its floodplains', gap.carvedSpan > 90, `narrowest section ${gap.carvedSpan} m of 100 m${gap.thrown ? '; ' + gap.thrown : ''}`);
  check('terrain with no data at the river never stops the build without a message', !gap.thrown && gap.ownAnswer, gap.thrown || gap.ownError || 'built');
  check('a model said to include the river bed, with no levels there, says to carve one', /Untick/.test(gap.ownError || ''), gap.ownError || 'built with no bed');

  // exports from the File menu
  const text = (await download(page, 'rf-csv')).toString('utf8');
  check('CSV carries the caution', text.includes('not a flood risk assessment'));
  check('CSV carries the settings', /Flow [\d.]+ m3\/s/.test(text) && /eddy zones on/.test(text));
  check('CSV lists bridges and buildings', /\nbridge,/.test(text) && /\nbuilding,/.test(text));

  // a CSV saved while showing "Without" says what it holds: the run with the design
  await page.click('[data-compare="before"]'); await settle(page);
  const withoutCsv = (await download(page, 'rf-csv')).toString('utf8');
  await page.click('[data-compare="with"]'); await settle(page);
  check('a CSV saved in the Without view is labelled as what it holds', !/shown without design elements/.test(withoutCsv) && /Results with the design elements/.test(withoutCsv), withoutCsv.split('\n').slice(0, 4).join(' / '));

  // a building behind a wall reads the same in the Section view and the CSV
  const savedDesign = await page.evaluate(() => JSON.stringify({ walls: window.RFL_UI.state.walls, buildings: window.RFL_UI.state.buildings }));
  await page.click('[data-add=walls]'); await settle(page);
  const secId = await page.evaluate(() => {
    const u = window.RFL_UI, s = u.result.sections[5], last = u.result.sections[u.result.sections.length - 1];
    Object.assign(u.state.walls[u.state.walls.length - 1], { side: 'left', x0: u.result.sections[0].x, x1: last.x, y: s.banks.left - 2, z: s.ws + 20 });
    Object.assign(u.state.buildings[0], { x: s.x, y: s.banks.left - 12, floor: s.ws - 0.5 });
    u.run();
    return s.id;
  });
  await settle(page);
  await page.evaluate(() => window.RFL_UI.setView('section'));
  await page.selectOption('#rf-view-sec', secId); await settle(page);
  const dryFill = await page.locator('.rf-cut-building').first().getAttribute('fill');
  const behindCsv = (await download(page, 'rf-csv')).toString('utf8');
  check('CSV says when a building is cut off from the river', /\nbuilding,.*,status\n[^\n]*cut off from the river/.test(behindCsv));
  await page.evaluate(() => { const u = window.RFL_UI; u.state.walls.pop(); u.run(); });
  await settle(page);
  const wetFill = await page.locator('.rf-cut-building').first().getAttribute('fill');
  check('Section view shows a building behind a wall as dry', dryFill !== wetFill, `${dryFill} behind the wall, ${wetFill} without it`);
  await page.evaluate(d => { const u = window.RFL_UI, o = JSON.parse(d); u.state.walls = o.walls; u.state.buildings = o.buildings; u.run(); }, savedDesign);
  await settle(page);
  await page.evaluate(() => window.RFL_UI.setView('3d'));
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

  // a damaged project file is refused whole, and the open project stays as it was
  const alerts = [], onDialog = d => { alerts.push(d.message()); d.accept(); };
  page.on('dialog', onDialog);
  const damaged = {
    'flow as text': s => { s.flow = { ...s.flow, Q: '15' }; },
    'walls not a list': s => { s.walls = {}; },
    'empty river line': s => { s.geo = { line: [], yc: 0 }; },
    'wall set-back as text': s => { s.walls = s.walls.map(w => ({ ...w, setback: '2' })); },
    'boundary without a slope': s => { s.boundary = { type: 'normal' }; },
  };
  const keep = await page.evaluate(() => JSON.stringify(window.RFL_UI.state.sections));
  for (const [what, spoil] of Object.entries(damaged)) {
    const bad = JSON.parse(JSON.stringify(saved)); spoil(bad.state);
    const n0 = alerts.length, errs0 = errors.length;
    await page.setInputFiles('#rf-file', { name: 'damaged.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(bad)) });
    await page.waitForTimeout(300); await settle(page);
    const same = (await page.evaluate(() => JSON.stringify(window.RFL_UI.state.sections))) === keep && (await page.evaluate(() => window.RFL_UI.state.obstructions.length)) === 1;
    check(`a project with ${what} is refused`, alerts.length === n0 + 1 && same && errors.length === errs0, `${alerts.length - n0} message(s): ${alerts.slice(n0).join(' | ')}; project kept: ${same}; errors: ${errors.slice(errs0).join(' | ')}`);
  }
  page.off('dialog', onDialog);

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
  // a higher flow can draw more objects, so compare at the same flow after the rebuilds
  const q0 = await page.evaluate(() => window.RFL_UI.state.flow.Q);
  const g0 = (await page.evaluate(() => window.RFL_UI.view3d)).geometries;
  for (let i = 0; i < 30; i++) await page.evaluate(i => { window.RFL_UI.state.flow.Q = 10 + i; window.RFL_UI.run(); }, i);
  await page.evaluate(q => { window.RFL_UI.state.flow.Q = q; window.RFL_UI.run(); }, q0);
  await settle(page);
  const v1 = await page.evaluate(() => window.RFL_UI.view3d);
  check('30 rebuilds of the 3D view leak no geometry', v1.geometries <= g0 && v1.geometries <= v1.meshes, `${g0} → ${v1.geometries} geometries held, ${v1.meshes} objects`);

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
  await page.click('#rf-map-build');
  check('map: building asks for the river shape', await page.locator('dialog #rf-dlg-ok').isVisible());
  check('map: the shape dialog does not ask for a length, as the line sets it', (await page.locator('dialog [data-k=length]').count()) === 0);
  await page.fill('dialog [data-k=chD]', '2.5');
  await page.fill('dialog [data-k=chW]', '12');
  await page.click('#rf-dlg-ok'); await settle(page);
  const shaped = await page.evaluate(() => { const s = window.RFL_UI.state.sections[3]; return { across: s.banks.right - s.banks.left, depth: s.pts[2][1] - s.pts[3][1], bed: s.pts[4][0] - s.pts[3][0] }; });
  check('map: the sliders shape the drawn river', Math.abs(shaped.across - 17) < 1e-6 && Math.abs(shaped.depth - 2.5) < 1e-3 && Math.abs(shaped.bed - 12) < 1e-6, JSON.stringify(shaped));
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
  // measure the map where it is now: building the reach changes the panel around it
  const mapNow = await page.locator('#rf-map').boundingBox();
  await page.mouse.click(mapNow.x + pt[0], mapNow.y + pt[1]); await settle(page);
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
  // opening a project somewhere else moves the map to it
  const elsewhere = JSON.parse(readFileSync(await sv.path(), 'utf8'));
  elsewhere.state.geo.line = elsewhere.state.geo.line.map(([la, lo]) => [la + 0.05, lo]);
  await page.evaluate(() => window.RFL_UI.setView('map')); await settle(page);
  await page.setInputFiles('#rf-file', { name: 'elsewhere.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(elsewhere)) });
  await page.waitForFunction(la => Math.abs(window.RFL_UI.state.geo.line[0][0] - la) < 1e-9, elsewhere.state.geo.line[0][0]); await settle(page);
  await page.evaluate(() => window.RFL_UI.setView('map')); await settle(page);
  const seen = await page.evaluate(() => { const u = window.RFL_UI, r = u.result.sections, el = document.getElementById('rf-map').getBoundingClientRect(); const p = u.screenOf(r[Math.floor(r.length / 2)].id); return { p, w: el.width, h: el.height }; });
  check('map: opening a project elsewhere moves the map to it', seen.p[0] > 0 && seen.p[0] < seen.w && seen.p[1] > 0 && seen.p[1] < seen.h, JSON.stringify(seen));

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
  await page.click('#rf-map-build'); await page.click('#rf-dlg-ok'); await settle(page);
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
  await p2.goto(origin + '/?tour=0'); await p2.waitForFunction(() => window.RFL_UI && window.RFL_UI.result);
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
  await page.goto(origin + '/?tour=0#advanced'); await page.waitForFunction(() => window.RFL_UI && window.RFL_UI.result);
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

// ---- floating object: weight sets the depth below the water ----
{
  const { page, ctx, errors } = await openPage({ width: 1440, height: 900 });
  await page.evaluate(() => { const S = window.RFL_UI.state; S.bridges = []; S.obstructions = []; S.walls = []; S.buildings = []; });
  await page.click('[data-add="floats"]');
  const f = 'details.rf-el[data-k="floats"]';
  await page.waitForSelector(f + '[open] [data-f="tonnes"]');
  const area = await page.evaluate(() => { const it = window.RFL_UI.state.floats[0]; return Math.abs(it.x1 - it.x0) * Math.abs(it.y1 - it.y0); });
  const shown = +(await page.inputValue(f + ' [data-f="tonnes"]'));
  check('float: weight shown is depth below the water × length × width', Math.abs(shown - 0.5 * area) < 0.01, `${shown} t for ${area} m²`);
  const rise = () => page.evaluate(() => { const r = window.RFL_UI.result, b = window.RFL_UI.base; return Math.max(...r.sections.map(s => s.ws - (b.sections.find(q => Math.abs(q.x - s.x) < 1e-6) || s).ws)); });
  const before = await rise();
  await page.fill(f + ' [data-f="tonnes"]', String(+(area * 0.9).toFixed(2))); await page.press(f + ' [data-f="tonnes"]', 'Tab'); await settle(page); await settle(page);
  const draft = await page.evaluate(() => window.RFL_UI.state.floats[0].draft);
  await page.fill(f + ' [data-f="tonnes"]', '0.1'); await page.press(f + ' [data-f="tonnes"]', 'Tab');
  const light = await page.evaluate(() => window.RFL_UI.state.floats[0].draft);
  check('float: a light weight is kept exact, not rounded to the millimetre', Math.abs(light - 0.1 / area) < 1e-12, `${light} m`);
  await page.fill(f + ' [data-f="tonnes"]', String(+(area * 0.9).toFixed(2))); await page.press(f + ' [data-f="tonnes"]', 'Tab'); await settle(page); await settle(page);
  check('float: typing a weight sets the depth below the water', Math.abs(draft - 0.9) < 0.002 && Math.abs(+(await page.inputValue(f + ' [data-f="draft"]')) - 0.9) < 0.002, `depth ${draft} m`);
  const after = await rise();
  check('float: a heavier object raises the water more', after > before + 1e-4, `${(before * 1000).toFixed(1)} mm → ${(after * 1000).toFixed(1)} mm`);
  await page.fill(f + ' [data-f="height"]', '3'); await page.press(f + ' [data-f="height"]', 'Tab'); await settle(page); await settle(page);
  check('float: height above the water does not change the levels', Math.abs(await rise() - after) < 1e-9);
  await page.fill(f + ' [data-f="tonnes"]', String(+(area * 20).toFixed(1))); await page.press(f + ' [data-f="tonnes"]', 'Tab'); await settle(page); await settle(page);
  check('float: too heavy for the water depth says it rests on the bed', /rests on the bed/.test(await page.textContent(f + ' .rf-el-body .rf-hint')));
  await page.fill(f + ' [data-f="tonnes"]', String(+(area * 0.9).toFixed(2))); await page.press(f + ' [data-f="tonnes"]', 'Tab'); await settle(page); await settle(page);
  const smoothRise = await rise();
  await page.fill(f + ' [data-f="n"]', '0.035'); await page.press(f + ' [data-f="n"]', 'Tab'); await settle(page); await settle(page);
  check('float: a rougher hull raises the water more', await rise() > smoothRise + 1e-4 && await page.evaluate(() => window.RFL_UI.state.floats[0].n) === 0.035);
  await page.evaluate(() => { location.hash = ''; });
  check('float: hull roughness shows in Advanced', await page.locator(f + ' [data-f="n"]').isVisible());
  check('float: no console errors', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

// ---- water coloured by speed, flow from a float survey, scour and settling hints ----
{
  const { page, ctx, errors } = await openPage({ width: 1440, height: 900 });
  await page.click('[data-preset="flood"]'); await settle(page); await settle(page);
  await page.click('.rf-views [data-view="plan"]'); await settle(page);
  const depthFills = await page.$$eval('#rf-plan rect', r => new Set(r.map(e => e.getAttribute('fill'))).size);
  await page.click('[data-waterby="speed"]'); await settle(page);
  const plan = await page.evaluate(() => ({ fills: [...document.querySelectorAll('#rf-plan rect')].map(e => e.getAttribute('fill')), legend: document.getElementById('rf-legend').textContent }));
  const speedCols = ['#d4ecf7', '#8fc6e6', '#f2d16b', '#ec8a3a', '#c4362b'];
  const used = new Set(plan.fills.filter(f => speedCols.includes(f)));
  check('speed: Plan colours the water by speed, faster under the bridge', used.size >= 3 && /Water speed/.test(plan.legend) && plan.fills.includes('#c4362b'), [...used].join(' '));
  // the bridge section's channel is in a faster band than the reach far upstream
  const bands = await page.evaluate(() => { const r = window.RFL_UI.result.sections, at = x => r.reduce((m, s) => Math.abs(s.x - x) < Math.abs(m.x - x) ? s : m).sub.ch.V; return [at(150), at(285)]; });
  check('speed: the channel is faster through the bridge than upstream', bands[0] > bands[1] * 1.1, bands.map(v => v.toFixed(2)).join(' against '));
  await page.click('[data-waterby="depth"]'); await settle(page);
  check('speed: Depth puts the plain water colour back', await page.$$eval('#rf-plan rect', r => !r.some(e => e.getAttribute('fill') === '#c4362b')) && depthFills > 0);
  const status = (await page.locator('#rf-status .rf-note').allTextContents()).join('\n');
  check('hints: the bridge is named for speeding the channel up', /speeds the channel up at 150–158 m/.test(status), status.split('\n').filter(t => /speed|slow/.test(t)).join(' | '));
  check('hints: the backwater upstream is named for slowing it', /slows the channel at/.test(status));
  check('hints: they say they come from the water speed only', /hints from the water speed only/.test(status));
  await page.click('#rf-survey summary');
  for (const [k, v] of [['w', 12], ['d', 1.2], ['L', 20], ['t', 25], ['k', 0.85]]) await page.fill('#rf-sv-' + k, String(v));
  const est = await page.textContent('#rf-sv-out');
  check('survey: float speed, mean speed and flow worked out', /Float 0\.80 m\/s/.test(est) && /mean speed ≈ 0\.68 m\/s/.test(est) && /flow ≈ 9\.79 m³\/s/.test(est), est);
  await page.click('#rf-sv-use'); await settle(page); await settle(page);
  const after = await page.evaluate(() => ({ Q: window.RFL_UI.state.flow.Q, allow: window.RFL_UI.state.flow.allowance, out: document.getElementById('rf-sv-out').textContent }));
  check('survey: Use this flow sets the flow and compares the model\'s speed', after.Q === 9.79 && after.allow === 0 && /model's channel speed is/.test(after.out), after.out.slice(-160));
  check('speed and survey: no console errors', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

// ---- a narrow view area, as when embedded in a web page ----
{
  const { page, ctx, errors } = await openPage({ width: 1150, height: 900 });
  for (const v of ['3d', 'plan', 'section', 'profile']) {
    await page.click(`.rf-views [data-view="${v}"]`); await settle(page);
    const r = await page.evaluate(v => {
      const box = e => e.getBoundingClientRect();
      const views = box(document.querySelector('.rf-views'));
      const tools = [...document.querySelectorAll('.rf-stage-tools > *')].filter(e => !e.hidden && e.offsetParent).map(box);
      const hit = tools.some(t => t.left < views.right && t.right > views.left && t.top < views.bottom && t.bottom > views.top);
      const lowest = Math.max(views.bottom, ...tools.map(t => t.bottom));
      const host = document.querySelector(`.rf-view[data-view="${v}"]`);
      // the first sizeable shape below the svg's own top edge (its background spans the whole svg)
      const svg = host && host.querySelector('svg'), top = svg && box(svg).top;
      const rect = svg && [...svg.querySelectorAll('rect, polyline, polygon')].map(box).filter(b => b.width > 50 && b.height > 20 && b.top > top + 2).sort((a, b) => a.top - b.top)[0];
      return { hit, lowest: Math.round(lowest), drawTop: rect ? Math.round(rect.top) : null };
    }, v);
    check(`narrow: ${v} tools clear of the view buttons`, !r.hit, JSON.stringify(r));
    if (v !== '3d') check(`narrow: ${v} drawing starts below the buttons and tools`, r.drawTop !== null && r.drawTop >= r.lowest, JSON.stringify(r));
  }
  check('narrow: no console errors', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

// ---- the river bed's material: where the flow can move it ----
{
  const { page, ctx, errors } = await openPage({ width: 1440, height: 900 });
  const notes = async () => (await page.locator('#rf-status .rf-note').allTextContents()).join('\n');
  check('bed: without a material the hints point to the River panel', /Choose what the river bed is made of/.test(await notes()));
  check('bed: the Bed colouring waits until a material is chosen', await page.locator('[data-waterby="bed"]').isDisabled());
  check('bed: the flow text appears once the river-full flow is ready', /river banks|full to the top|spills/.test(await page.textContent('#rf-flow-plain')));
  await page.click('[data-preset="flood"]'); await settle(page); await settle(page);
  await page.click('#rf-river-sec summary');
  await page.selectOption('#rf-bed', '30'); await settle(page); await settle(page);
  let n = await notes();
  check('bed: coarse gravel moves through the bridge and builds up in its backwater', /Coarse gravel moves at .*0–165 m/.test(n) && /Coarse gravel builds up at 180–210 m/.test(n), n.split('\n').filter(t => /gravel/i.test(t)).join(' | '));
  check('bed: the bridge is named for making gravel build up', /Your bridge makes coarse gravel build up at 180–210 m/.test(n));
  check('bed: the speed-only design hints give way to the threshold', !/speeds the channel up/.test(n) && /Shields’ threshold/.test(n));
  await page.click('.rf-views [data-view="plan"]'); await page.click('[data-waterby="bed"]'); await settle(page);
  const fills = await page.$$eval('#rf-plan rect', r => r.map(e => e.getAttribute('fill')));
  check('bed: Plan colours the channel red where gravel moves and blue where it builds up', fills.includes('#d8453b') && fills.includes('#2f7fd1') && /Does the water move the bed\? coarse gravel/.test(await page.textContent('#rf-legend')));
  check('bed: the legend names the three states', /Moving:.*Building up:.*Stable:/.test(await page.textContent('#rf-legend')));
  await page.selectOption('#rf-bed', '100'); await settle(page); await settle(page);
  check('bed: cobbles are stable at this flow', /The bed is stable along the whole river at this flow: the water cannot move cobbles anywhere/.test(await notes()));
  check('bed: with cobbles the whole channel shows stable grey, not building up', await page.$$eval('#rf-plan rect', r => { const f = r.map(e => e.getAttribute('fill')); return f.includes('#7e8c9a') && !f.includes('#2f7fd1') && !f.includes('#d8453b'); }));
  await page.selectOption('#rf-bed', 'other');
  check('bed: Other grain size shows the size field', await page.locator('#rf-bed-d').isVisible());
  await page.fill('#rf-bed-d', '0.03'); await page.press('#rf-bed-d', 'Tab'); await settle(page);
  check('bed: silt finer than sand is refused', await page.evaluate(() => window.RFL_UI.state.bed.d) === 100);
  await page.fill('#rf-bed-d', '8'); await page.press('#rf-bed-d', 'Tab'); await settle(page); await settle(page);
  check('bed: a grain size of your own is used', await page.evaluate(() => window.RFL_UI.state.bed.d) === 8 && /grains of 8 mm/i.test(await notes()));
  const [dl] = await Promise.all([page.waitForEvent('download'), page.evaluate(() => document.getElementById('rf-csv').click())]);
  const text = readFileSync(await dl.path(), 'utf8');
  check('bed: the CSV gives the bed force and names the bed', /bed_force_n_m2/.test(text) && /river bed grains of 8 mm/.test(text));
  await page.selectOption('#rf-bed', ''); await settle(page); await settle(page);
  check('bed: clearing the material puts the colouring back to depth', await page.$eval('[data-waterby][aria-pressed="true"]', b => b.dataset.waterby) === 'depth');
  check('bed: no console errors', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

// ---- settings saved under the app's old name are carried across ----
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.addInitScript(() => { if (!sessionStorage.getItem('seeded')) { sessionStorage.setItem('seeded', '1'); localStorage.setItem('riverfloodlab.theme.v1', 'dark'); localStorage.setItem('riverfloodlab.tour.optout.v1', '1'); } });
  const page = await ctx.newPage();
  await page.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
  await page.goto(origin + '/'); await page.waitForFunction(() => window.RFL_UI && window.RFL_UI.result); await page.waitForTimeout(900);
  const s = await page.evaluate(() => ({ theme: localStorage.getItem('riverflowlab.theme.v1'), old: localStorage.getItem('riverfloodlab.theme.v1'), dark: document.documentElement.getAttribute('data-theme') }));
  check('rename: a theme saved as River Flood Lab is kept', s.theme === 'dark' && s.old === null && s.dark === 'dark', JSON.stringify(s));
  check('rename: a tour opt-out saved as River Flood Lab is kept', await page.locator('#rf-tour').isHidden());
  await ctx.close();
}

// ---- guided tour and the © card ----
for (const size of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  const tag = size.width < 900 ? 'phone' : 'desktop';
  const ctx = await browser.newContext({ viewport: size });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
  await page.goto(origin + '/'); await page.waitForFunction(() => window.RFL_UI && window.RFL_UI.result);
  await page.waitForSelector('#rf-tour:not([hidden])', { timeout: 5000 }).catch(() => {});
  check(`tour (${tag}): opens on first launch`, await page.locator('#rf-tour').isVisible());
  const drawer0 = await page.evaluate(() => document.getElementById('rf-root').dataset.drawer);
  const steps = await page.evaluate(() => window.RFL_UI.tour.steps);
  const bad = [];
  for (let i = 0; i < steps; i++) {
    await page.waitForTimeout(320);
    const r = await page.evaluate(() => {
      const c = document.getElementById('rf-tour').getBoundingClientRect(), s = document.getElementById('rf-tour-spot').getBoundingClientRect();
      const inside = c.left >= 0 && c.top >= 0 && c.right <= innerWidth + 1 && c.bottom <= innerHeight + 1;
      const dim = document.getElementById('rf-tour-spot').classList.contains('rf-dim-only');
      // the card must not sit over the middle of the spotlit target unless the target fills the screen
      const overlap = !dim && Math.max(0, Math.min(c.right, s.right) - Math.max(c.left, s.left)) * Math.max(0, Math.min(c.bottom, s.bottom) - Math.max(c.top, s.top));
      // a target the size of the view leaves nowhere else for the card
      const big = s.width * s.height > innerWidth * innerHeight * 0.3;
      return { inside, title: document.getElementById('rf-tour-title').textContent, ok: inside && (big || !overlap || overlap < c.width * c.height * 0.25) };
    });
    if (!r.ok) bad.push(`${i + 1} ${r.title}`);
    await page.click('#rf-tour-next');
  }
  check(`tour (${tag}): every step's card is on screen and clear of its target`, bad.length === 0, bad.join('; '));
  check(`tour (${tag}): Finish closes it`, await page.locator('#rf-tour').isHidden() && await page.locator('#rf-tour-spot').isHidden());
  const after = await page.evaluate(() => ({ drawer: document.getElementById('rf-root').dataset.drawer, river: document.getElementById('rf-river-sec').open }));
  check(`tour (${tag}): puts back the drawer and closes what it opened`, after.drawer === drawer0 && !after.river, JSON.stringify(after));
  await page.click('#rf-help');
  check(`tour (${tag}): Tour button replays it`, await page.locator('#rf-tour').isVisible());
  await page.keyboard.press('Escape');
  check(`tour (${tag}): Escape closes it`, await page.locator('#rf-tour').isHidden());
  await page.click('#rf-credit');
  const about = await page.evaluate(() => ({ text: document.getElementById('rf-about').textContent, over: (() => { const r = document.getElementById('rf-about').getBoundingClientRect(); return r.left < 0 || r.right > innerWidth + 1; })() }));
  check(`about (${tag}): clicking © shows licence, release and citation`, await page.locator('#rf-about').isVisible() && /MIT/.test(about.text) && /CC BY 4\.0/.test(about.text) && /Version 0\.1\.0/.test(about.text) && /@software\{alobaidi2026riverflowlab/.test(about.text) && /Al-Obaidi, K\. M\. \(2026\)/.test(about.text));
  check(`about (${tag}): fits the window`, !about.over);
  await page.keyboard.press('Escape');
  check(`about (${tag}): Escape closes it`, await page.locator('#rf-about').isHidden());
  check(`about (${tag}): the footer no longer carries the caution`, !/not a flood risk assessment/.test(await page.textContent('.rf-foot')));
  check(`tour (${tag}): no page errors`, errors.length === 0, errors.join(' | '));
  if (tag === 'desktop') {
    await page.click('#rf-help'); await page.check('#rf-tour-dont'); await page.click('#rf-tour-skip');
    await page.goto(origin + '/'); await page.waitForFunction(() => window.RFL_UI && window.RFL_UI.result); await page.waitForTimeout(1000);
    check('tour: "Don\'t show this on launch" is remembered', await page.locator('#rf-tour').isHidden());
    await page.goto(origin + '/?tour=1'); await page.waitForFunction(() => window.RFL_UI && window.RFL_UI.result);
    await page.waitForSelector('#rf-tour:not([hidden])', { timeout: 5000 }).catch(() => {});
    check('tour: ?tour=1 shows it anyway', await page.locator('#rf-tour').isVisible());
  }
  await ctx.close();
}

await browser.close(); server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
