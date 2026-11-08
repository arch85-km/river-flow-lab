// Bundles the parts of three.js the page uses (tools/three-entry.js) into
// index.html, between the three:start and three:end markers, as a
// minified script that sets window.RFL_THREE.
//
// Source: three.js (MIT), pinned in package.json; its licence notice
// travels in NOTICE and in the bundle header.
//
// Usage: npm install && node tools/build-three.mjs

import { build } from 'esbuild';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const version = JSON.parse(readFileSync(new URL('node_modules/three/package.json', root))).version;
const out = await build({
  entryPoints: [fileURLToPath(new URL('tools/three-entry.js', root))],
  bundle: true, minify: true, format: 'iife', globalName: 'RFL_THREE',
  legalComments: 'none', write: false, target: 'es2020',
});
let code = out.outputFiles[0].text.trim();
if (/<\/script/i.test(code)) throw new Error('bundle contains a closing script tag');
const offsite = code.match(/https?:\/\/[A-Za-z0-9.-]+/g) || [];
const block = `<!-- three:start -->\n<script id="rfl-three">\n/* three.js ${version} (selected modules) — MIT License, Copyright © 2010-2026 three.js authors. See NOTICE. */\n${code}\n</script>\n<!-- three:end -->`;
const file = new URL('index.html', root);
const html = readFileSync(file, 'utf8');
const re = /<!-- three:start -->[\s\S]*?<!-- three:end -->/;
if (!re.test(html)) throw new Error('markers not found in index.html');
writeFileSync(file, html.replace(re, () => block));
console.log(`three.js ${version}: ${(code.length / 1024).toFixed(0)} kB inlined; URLs mentioned in the bundle: ${[...new Set(offsite)].join(', ') || 'none'}`);
