#!/usr/bin/env node
// Remakes the screenshots in docs/ from index.html, in headless Chromium.
// Usage: node tools/make-screenshots.mjs   (Playwright from NODE_PATH, as for tests/ui.test.mjs)
//
// The template reach with its example bridge at Major flood, light theme. The
// Map view is left out: its tiles are OpenStreetMap's, under their own licence.
import { createRequire } from 'node:module';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(ROOT, 'index.html'));
const server = http.createServer((q, r) => { if (q.url.split('?')[0] === '/') { r.writeHead(200, { 'content-type': 'text/html' }); r.end(html); } else { r.writeHead(404); r.end(); } }).listen(0, '127.0.0.1');
await new Promise(r => server.once('listening', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const errors = [];

async function open(viewport, query = '?tour=0') {
  const page = await browser.newPage({ viewport, colorScheme: 'light' });
  page.on('pageerror', e => errors.push(String(e)));
  await page.route('**/*', r => r.request().url().startsWith(origin) ? r.continue() : r.abort());
  await page.goto(origin + '/' + query);
  await page.waitForFunction(() => window.RFL_UI && window.RFL_UI.result);
  return page;
}
const settle = page => page.waitForTimeout(500);
const shot = async (page, name) => { await page.screenshot({ path: join(ROOT, 'docs', name) }); console.log('  docs/' + name); };

const desk = await open({ width: 1440, height: 900 });
await desk.click('[data-preset="flood"]'); await settle(desk);
await shot(desk, 'screenshot-3d.png');
await desk.click('.rf-views [data-view="plan"]'); await desk.click('[data-waterby="speed"]'); await settle(desk);
await shot(desk, 'screenshot-plan-speed.png');
await desk.click('[data-waterby="depth"]');
await desk.click('.rf-views [data-view="section"]'); await settle(desk);
await shot(desk, 'screenshot-section.png');
await desk.click('.rf-views [data-view="profile"]'); await settle(desk);
await shot(desk, 'screenshot-profile.png');
await desk.close();

const tour = await open({ width: 1440, height: 900 }, '?tour=1');
await tour.waitForSelector('#rf-tour:not([hidden])');
await tour.click('#rf-tour-next'); await tour.click('#rf-tour-next'); await settle(tour);
await shot(tour, 'screenshot-tour.png');
await tour.close();

const phone = await open({ width: 390, height: 844 });
await phone.click('[data-preset="flood"]'); await settle(phone);
await shot(phone, 'screenshot-mobile.png');
await phone.close();

await browser.close(); server.close();
if (errors.length) { console.error('page errors: ' + errors.join(' | ')); process.exit(1); }
