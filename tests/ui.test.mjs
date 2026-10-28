// Browser checks for River Flood Lab, in headless Chromium.
//
// Serves the folder over http://127.0.0.1, refuses every off-origin request,
// and drives the page: flow slider, design elements, section editor,
// exports, themes, and layout at four window sizes.
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

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
}

const browser = await chromium.launch();
async function openPage(size, scheme = 'light') {
  const ctx = await browser.newContext({ viewport: size, colorScheme: scheme, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [], offOrigin = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.route('**/*', route => {
    const u = route.request().url();
    if (u.startsWith(origin) || u.startsWith('data:') || u.startsWith('blob:')) return route.continue();
    offOrigin.push(u); return route.abort();
  });
  await page.goto(origin + '/');
  await page.waitForFunction(() => window.RFL_UI && window.RFL_UI.result);
  // the rating curve is drawn after a short pause so the slider stays responsive
  await page.waitForFunction(() => document.querySelector('#rf-rc svg polyline'));
  return { page, ctx, errors, offOrigin };
}
const ws = (page, x) => page.evaluate(x => { const r = window.RFL_UI.result; const s = r.sections; for (let i = 0; i < s.length - 1; i++) if (x <= s[i + 1].x) return s[i].ws + (s[i + 1].ws - s[i].ws) * (x - s[i].x) / (s[i + 1].x - s[i].x); return s[s.length - 1].ws; }, x);
const settle = page => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));

// ---- layout at four sizes, both themes ----
for (const scheme of ['light', 'dark']) {
  for (const size of [{ width: 1440, height: 900 }, { width: 1280, height: 820 }, { width: 900, height: 700 }, { width: 390, height: 844 }]) {
    const { page, ctx, errors, offOrigin } = await openPage(size, scheme);
    const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check(`${scheme} ${size.width}×${size.height}: no horizontal overflow`, over === 0, `${over}px`);
    const svgs = await page.evaluate(() => [...document.querySelectorAll('.rf-chart svg')].filter(s => s.getBoundingClientRect().width > 100).length);
    check(`${scheme} ${size.width}: four charts drawn`, svgs === 4, `${svgs}`);
    check(`${scheme} ${size.width}: no console errors`, errors.length === 0, errors.join(' | '));
    check(`${scheme} ${size.width}: no off-origin requests`, offOrigin.length === 0, offOrigin.join(' '));
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
    for (const e of document.querySelectorAll('h1,h2,p,label,button,td,th,.rf-chip,.rf-caution,option')) {
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
{
  const { page, ctx, errors } = await openPage({ width: 1440, height: 900 });
  const st = await page.evaluate(() => ({ n: window.RFL_UI.state.sections.length, br: window.RFL_UI.state.bridges.length }));
  check('template reach loads with sections and the example bridge', st.n === 21 && st.br === 1, JSON.stringify(st));

  // flow slider raises the water
  const w0 = await ws(page, 150);
  await page.fill('#rf-q', '40'); await page.press('#rf-q', 'Enter'); await page.locator('#rf-q').blur(); await settle(page);
  const w1 = await ws(page, 150);
  check('more flow raises the water', w1 > w0 + 0.1, `${w0.toFixed(3)} → ${w1.toFixed(3)} m`);
  await page.locator('#rf-q-range').fill('900'); await settle(page);
  const q = await page.evaluate(() => window.RFL_UI.state.flow.Q);
  check('slider sets the flow', q > 40, `${q} m³/s`);
  await page.fill('#rf-q', '20'); await page.locator('#rf-q').blur(); await settle(page);

  // climate allowance
  const a0 = await ws(page, 200);
  await page.fill('#rf-allow', '30'); await page.locator('#rf-allow').blur(); await settle(page);
  const a1 = await ws(page, 200);
  check('climate allowance raises the water', a1 > a0, `+${((a1 - a0) * 1000).toFixed(0)} mm`);
  check('flow readout includes the allowance', (await page.textContent('#rf-q-out')).includes('+30%'));
  await page.fill('#rf-allow', '0'); await page.locator('#rf-allow').blur(); await settle(page);

  // bridge status names what it judged
  const status = await page.textContent('#rf-status');
  check('bridge status states the soffit clearance or pressure flow', /soffit/.test(status), status.slice(0, 120));
  check('afflux and Yarnell shown', /afflux/.test(status) && /Yarnell/.test(status));

  // add an obstruction from the panel
  const before = await ws(page, 220);
  await page.click('.rf-tabs [data-tab=obstructions]');
  await page.selectOption('#rf-sec-pick', { label: 'XS15 · 210.0 m' });
  await page.click('#rf-add'); await settle(page);
  const item = page.locator('.rf-item').first();
  await item.locator('[data-k=y1]').fill('30'); await item.locator('[data-k=y1]').blur(); await settle(page);
  const after = await ws(page, 240);
  const beforeUp = before; // water at 220 before, compare upstream of the block
  check('obstruction raises the water upstream', after > (await page.evaluate(() => { const b = window.RFL_UI.base; const s = b.sections; const x = 240; for (let i = 0; i < s.length - 1; i++) if (x <= s[i + 1].x) return s[i].ws + (s[i + 1].ws - s[i].ws) * (x - s[i].x) / (s[i + 1].x - s[i].x); })), `${after.toFixed(3)} m with it`);
  const eddies = await page.locator('#rf-plan polygon').count();
  check('eddy zones drawn in plan', eddies >= 2, `${eddies} polygons`);
  check('table shows change against no design', (await page.textContent('#rf-table')).includes('Change, m'));

  // eddy toggle
  await page.click('.rf-tabs [data-tab=eddy]');
  await page.uncheck('#rf-eddy-on'); await settle(page);
  check('turning eddy zones off removes them', (await page.locator('#rf-plan polygon').count()) === 0);
  await page.check('#rf-eddy-on'); await settle(page);

  // wall and building
  await page.click('.rf-tabs [data-tab=walls]'); await page.click('#rf-add'); await settle(page);
  await page.click('.rf-tabs [data-tab=buildings]'); await page.click('#rf-add'); await settle(page);
  const s2 = await page.textContent('#rf-status');
  check('building gets a floor-level verdict', /Building 1: (floor|.* of water over the floor)/.test(s2), s2.match(/Building 1[^]*?(?=Building|$)/)?.[0]?.slice(0, 80));

  // section editor validates
  await page.fill('#rf-sec-pts', '0 5\n10 x\n20 5');
  await page.click('#rf-sec-apply');
  check('editor refuses a bad line', /Line 2/.test(await page.textContent('#rf-sec-msg')));
  await page.fill('#rf-sec-pts', '0 5\n20 1\n10 5');
  await page.click('#rf-sec-apply');
  check('editor refuses offsets out of order', /left to right/.test(await page.textContent('#rf-sec-msg')));

  // CSV export carries the caution and settings
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#rf-csv')]);
  const text = readFileSync(await dl.path(), 'utf8');
  check('CSV carries the caution', text.includes('not a flood risk assessment'));
  check('CSV carries the settings', /Flow [\d.]+ m3\/s/.test(text) && /eddy zones on/.test(text));
  check('CSV lists bridges and buildings', /\nbridge,/.test(text) && /\nbuilding,/.test(text));

  // PNG export
  const [png] = await Promise.all([page.waitForEvent('download'), page.click('#rf-png')]);
  const buf = readFileSync(await png.path());
  check('section PNG exports', buf.length > 5000 && buf[1] === 0x50, `${buf.length} bytes`);

  // save and reopen
  const [sv] = await Promise.all([page.waitForEvent('download'), page.click('#rf-save')]);
  const saved = JSON.parse(readFileSync(await sv.path(), 'utf8'));
  check('project saves design elements', saved.state.obstructions.length === 1 && saved.state.walls.length === 1 && saved.state.buildings.length === 1);
  await page.click('#rf-new'); await page.click('#rf-dlg-ok'); await settle(page);
  check('new reach clears design elements', (await page.evaluate(() => window.RFL_UI.state.obstructions.length + window.RFL_UI.state.bridges.length)) === 0);
  await page.setInputFiles('#rf-file', await sv.path()); await page.waitForFunction(() => window.RFL_UI.state.obstructions.length === 1);
  check('project reopens', true);

  // theme switch
  await page.click('#rf-theme'); await page.click('#rf-theme');
  check('theme switches to dark', (await page.evaluate(() => document.documentElement.dataset.theme)) === 'dark');
  check('no console errors during interaction', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

await browser.close(); server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
