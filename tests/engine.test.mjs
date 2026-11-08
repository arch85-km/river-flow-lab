// Engine checks for River Flood Lab.
//
// Each check compares the engine with an independent closed-form result or
// a separate numerical integration written here. Agreement shows the
// engine is internally consistent with open-channel theory; it is not
// validation against measured river levels.
//
// Usage: node tests/engine.test.mjs

import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const src = html.match(/<script id="rfl-engine">([\s\S]*?)<\/script>/)[1];
const ctx = { module: { exports: {} } };
vm.createContext(ctx);
vm.runInContext(src, ctx);
const RFL = ctx.module.exports;
const G = 9.81;

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const mm = v => (v * 1000).toFixed(2) + ' mm';

// ---- shapes ----
const rect = (b, z0, wall = 10) => [[0, z0 + wall], [0, z0], [b, z0], [b, z0 + wall]];
const trap = (b, m, z0, h = 10) => [[0, z0 + h], [m * h, z0], [m * h + b, z0], [2 * m * h + b, z0 + h]];
const section = (x, pts, n = 0.03, banks) => ({ id: `xs${x}`, x, pts, n: { lob: n, ch: n, rob: n },
  banks: banks || { left: pts[0][0], right: pts[pts.length - 1][0] } });

// Independent Manning normal depth by Newton iteration.
function manningDepth(Q, n, S, area, perim) {
  let y = 1;
  const f = y => area(y) * Math.pow(area(y) / perim(y), 2 / 3) * Math.sqrt(S) / n - Q;
  for (let i = 0; i < 100; i++) { const d = (f(y + 1e-6) - f(y)) / 1e-6; y -= f(y) / d; }
  return y;
}

// 1. Normal depth, rectangular channel
{
  const b = 10, n = 0.03, S = 0.001, Q = 20;
  const y = manningDepth(Q, n, S, y => b * y, y => b + 2 * y);
  const ws = RFL.normalWS(RFL.prepare({ sections: [section(0, rect(b, 0), n), section(10, rect(b, 0.01), n)] }).preps[0], Q, S);
  check('normal depth, rectangular 10 m, Q 20', near(ws, y, 1e-4), `engine ${ws.toFixed(4)} m, Manning ${y.toFixed(4)} m`);
}

// 2. Normal depth, trapezoidal channel (side slope 2:1)
{
  const b = 6, m = 2, n = 0.035, S = 0.002, Q = 35;
  const y = manningDepth(Q, n, S, y => (b + m * y) * y, y => b + 2 * y * Math.sqrt(1 + m * m));
  const ws = RFL.normalWS(RFL.prepare({ sections: [section(0, trap(b, m, 0), n), section(10, trap(b, m, 0.02), n)] }).preps[0], Q, S);
  check('normal depth, trapezoid 6 m base 2:1, Q 35', near(ws, y, 1e-4), `engine ${ws.toFixed(4)} m, Manning ${y.toFixed(4)} m`);
}

// 3. Critical depth, rectangular channel: yc = (q²/g)^(1/3)
{
  const b = 8, Q = 30, yc = Math.cbrt((Q / b) ** 2 / G);
  const wc = RFL.criticalWS(RFL.prepare({ sections: [section(0, rect(b, 0)), section(10, rect(b, 0))] }).preps[0], Q);
  check('critical depth, rectangular 8 m, Q 30', near(wc, yc, 1e-4), `engine ${wc.toFixed(4)} m, closed form ${yc.toFixed(4)} m`);
}

// 4. Uniform channel stays at normal depth all the way up
{
  const b = 10, n = 0.03, S = 0.001, Q = 25;
  const secs = []; for (let x = 0; x <= 500; x += 25) secs.push(section(x, rect(b, x * S), n));
  const r = RFL.solve({ sections: secs, boundary: { type: 'normal', slope: S }, eddy: { on: false } }, Q);
  const yn = manningDepth(Q, n, S, y => b * y, y => b + 2 * y);
  const worst = Math.max(...r.sections.map(s => Math.abs(s.depth - yn)));
  check('uniform flow holds normal depth over 500 m', worst < 1e-3, `worst departure ${mm(worst)}`);
}

// 5. M1 backwater curve against RK4 integration of the GVF equation
//    dy/dx = (S0 - Sf) / (1 - Fr²), integrated upstream from a raised level.
{
  const b = 12, n = 0.035, S = 0.0015, Q = 30, y0 = 3.0;
  const Sf = y => { const A = b * y, R = A / (b + 2 * y); return (Q * n / (A * Math.pow(R, 2 / 3))) ** 2; };
  const Fr2 = y => Q * Q / (G * (b * y) ** 3 / b);
  const dydx = y => -(S - Sf(y)) / (1 - Fr2(y)); // x measured upstream
  const ode = [y0]; const h = 0.5;
  for (let x = 0; x < 1000; x += h) {
    const y = ode[ode.length - 1];
    const k1 = dydx(y), k2 = dydx(y + h / 2 * k1), k3 = dydx(y + h / 2 * k2), k4 = dydx(y + h * k3);
    ode.push(y + h / 6 * (k1 + 2 * k2 + 2 * k3 + k4));
  }
  // The GVF equation has no eddy losses, so the comparison runs without them.
  const run = dx => {
    const secs = []; for (let x = 0; x <= 1000; x += dx) secs.push(section(x, rect(b, x * S), n));
    const r = RFL.solve({ sections: secs, boundary: { type: 'ws', ws: y0 }, eddy: { on: false }, coeff: { cc: 0, ce: 0 } }, Q);
    return { r, worst: Math.max(...r.sections.map(s => Math.abs(s.depth - ode[Math.round(s.x / h)]))) };
  };
  const { r, worst } = run(20), fine = run(5).worst;
  check('M1 backwater over 1 km, 20 m steps, matches RK4 within 5 mm', worst < 5e-3, `worst difference ${mm(worst)}`);
  check('M1 difference shrinks with the step (5 m steps)', fine < worst / 4, `${mm(fine)} at 5 m against ${mm(worst)} at 20 m`);
  const last = r.sections[r.sections.length - 1].depth;
  const yn = manningDepth(Q, n, S, y => b * y, y => b + 2 * y);
  check('M1 curve falls towards normal depth upstream', last > yn && last < y0, `${last.toFixed(3)} m between ${yn.toFixed(3)} and ${y0}`);
}

// A small two-stage valley used by the remaining checks.
const valley = z0 => [[0, z0 + 3], [10, z0 + 1.6], [18, z0 + 1.5], [20, z0], [28, z0], [30, z0 + 1.5], [40, z0 + 1.6], [50, z0 + 3]];
const vsec = x => ({ id: `v${x}`, x, pts: valley(x * 0.002), n: { lob: 0.06, ch: 0.035, rob: 0.06 }, banks: { left: 18, right: 30 } });
const vsecs = () => { const s = []; for (let x = 0; x <= 300; x += 15) s.push(vsec(x)); return s; };
const base = { boundary: { type: 'normal', slope: 0.002 } };

// 6. A blocked obstruction raises the water upstream, not downstream
{
  const Q = 40;
  const r0 = RFL.solve({ ...base, sections: vsecs() }, Q);
  const r1 = RFL.solve({ ...base, sections: vsecs(), obstructions: [{ id: 'ob', x0: 140, x1: 160, y0: 21, y1: 27, top: 5 }] }, Q);
  const up0 = RFL.wsAt(r0, 200), up1 = RFL.wsAt(r1, 200), dn0 = RFL.wsAt(r0, 100), dn1 = RFL.wsAt(r1, 100);
  check('obstruction raises the level upstream', up1 - up0 > 0.01, `+${mm(up1 - up0)} at 200 m`);
  check('obstruction leaves the level downstream unchanged', Math.abs(dn1 - dn0) < 1e-6, `${mm(dn1 - dn0)} at 100 m`);
  const r2 = RFL.solve({ ...base, sections: vsecs(), obstructions: [{ id: 'ob0', x0: 140, x1: 160, y0: 24, y1: 24, top: 5 }], eddy: { on: false } }, Q);
  check('zero-width obstruction changes nothing', Math.abs(RFL.wsAt(r2, 200) - up0) < 1e-6);
}

// 7. Eddy zones: sized by the expansion and contraction ratios
{
  check('eddy behind a mid-channel block, 4 m wide, ER 2 → 4 m long', RFL.eddyLength({ y0: 22, y1: 26 }, 2, 0, 50) === 4);
  check('eddy behind an abutment, 5 m wide, ER 2 → 10 m long', RFL.eddyLength({ y0: -Infinity, y1: 5 }, 2, 0, 50) === 10);
  const s = RFL.eddySpan({ y0: 22, y1: 26 }, 2, 2, 0, 50);
  check('eddy behind a block narrows as flow re-expands', s && near(s[0], 23, 1e-9) && near(s[1], 25, 1e-9), JSON.stringify(s));
  const Q = 40;
  const on = RFL.solve({ ...base, sections: vsecs(), obstructions: [{ id: 'ob', x0: 150, x1: 150, y0: 0, y1: 16, top: 5 }], eddy: { on: true, er: 2, cr: 1 } }, Q);
  const off = RFL.solve({ ...base, sections: vsecs(), obstructions: [{ id: 'ob', x0: 150, x1: 150, y0: 0, y1: 16, top: 5 }], eddy: { on: false } }, Q);
  // Block from the left edge, 16 m wide: 32 m of eddy downstream (ER 2), 16 m upstream (CR 1).
  // Narrow enough not to choke the flow, so the level above it still feels the reach below.
  const inZone = on.sections.filter(s => s.eddies.length).map(s => s.x);
  check('eddy zones mark the sections inside them', inZone.join() === '120,135,165', `sections ${inZone.join(', ')}`);
  check('the obstruction does not choke the flow', !on.sections.some(s => s.flags.includes('critical')));
  check('eddy zones raise the level above the obstruction', RFL.wsAt(on, 200) > RFL.wsAt(off, 200), `+${mm(RFL.wsAt(on, 200) - RFL.wsAt(off, 200))}`);
}

// 8. Levee: overbank behind it carries nothing until overtopped
{
  const s = vsec(0); s.levees = { left: { y: 15, z: 2.5 } };
  const p = RFL.prepare({ sections: [s, vsec(15)] }).preps[0];
  const h = RFL.hydraulics(p, 2.0, 40), h0 = RFL.hydraulics(RFL.prepare({ sections: [vsec(0), vsec(15)] }).preps[0], 2.0, 40);
  check('levee excludes the overbank behind it', h.sub.lob.A < h0.sub.lob.A, `${h.sub.lob.A.toFixed(2)} vs ${h0.sub.lob.A.toFixed(2)} m²`);
  const h2 = RFL.hydraulics(p, 2.6, 40), h20 = RFL.hydraulics(RFL.prepare({ sections: [vsec(0), vsec(15)] }).preps[0], 2.6, 40);
  check('overtopped levee lets the overbank flow', near(h2.sub.lob.A, h20.sub.lob.A, 1e-9));
}

// 8a. Flood walls: a short wall still acts, and interpolated sections keep it
{
  const wall = { side: 'left', x0: 152, x1: 163, y: 15, z: 9 };
  const without = RFL.solve({ ...base, sections: vsecs() }, 80);
  const short = RFL.solve({ ...base, sections: vsecs(), walls: [wall] }, 80);
  const rise = RFL.wsAt(short, 200) - RFL.wsAt(without, 200);
  check('a wall between two sections still raises the water upstream', rise > 0.001, mm(rise));
  const span = { side: 'left', x0: 140, x1: 175, y: 15, z: 9 };
  const br = { id: 'br', x: 150, length: 8, openLeft: 10, openRight: 40, lowChord: 8, highChord: 9, piers: [] };
  const inserted = RFL.prepare({ sections: vsecs(), bridges: [br], walls: [span] }).preps.find(p => Math.abs(p.x - 158) < 1e-6);
  check('an interpolated section inside a wall keeps the wall', !!inserted && inserted.excl.some(e => e.kind === 'levee'));
}

// 8b. Design elements outside the reach are reported, not crashed on
{
  const br = { id: 'far', x: 5000, length: 8, openLeft: 17, openRight: 31, lowChord: 2.4, highChord: 3.2, piers: [] };
  let r, thrown = null;
  try { r = RFL.solve({ ...base, sections: vsecs(), bridges: [br] }, 20); } catch (e) { thrown = e; }
  check('a bridge outside the reach is refused with a message', !thrown && !!(r && r.error), thrown ? String(thrown) : (r && r.error) || 'no error');
  const res = RFL.solve({ ...base, sections: vsecs() }, 20);
  const last = res.sections[res.sections.length - 1].x;
  const [out] = RFL.buildings(res, [{ id: 'h', x: last + 100, floor: 1 }]);
  check('a building outside the reach has no water level', out.ws === null && out.depth === null);
}

// 8c. Soffit clearance agrees with the flow regime at every soffit height
{
  let bad = 0, seen = 0, lowOnly = null;
  for (let lc = 1.6; lc < 2; lc += 0.005) {
    const b = RFL.solve({ ...base, sections: vsecs(), bridges: [{ id: 'br', x: 150, length: 30, openLeft: 17, openRight: 31, lowChord: lc, highChord: lc + 0.8, piers: [] }] }, 20).bridges[0];
    seen++;
    if ((b.flow === 'low') !== (b.freeboard >= 0)) { bad++; if (lowOnly === null) lowOnly = `soffit ${lc.toFixed(2)}: ${b.flow}, clearance ${b.freeboard.toFixed(3)} m`; }
  }
  check('soffit clearance is positive only when the opening runs free', bad === 0, bad ? `${bad} of ${seen}; first at ${lowOnly}` : `${seen} soffit heights`);
}

// 8d. Extra stations give two runs the same sections to compare
{
  const r = RFL.solve({ ...base, sections: vsecs(), stations: [158] }, 20);
  check('a requested station becomes a section with a result', r.sections.some(s => Math.abs(s.x - 158) < 1e-6));
}

// 8e. An eddy zone shorter than the section spacing still acts
{
  const ob = { id: 'o', x0: 150, x1: 154, y0: 21, y1: 27, top: 9 };
  const on = RFL.solve({ ...base, sections: vsecs(), obstructions: [ob], eddy: { on: true, er: 2, cr: 1 } }, 20);
  const acting = on.sections.filter(s => s.eddies.length).length;
  check('an eddy zone shorter than the section spacing reaches a section', acting > 0, `${acting} sections`);
}

// 8f. A block marked noEddy (a strip of an imported model) makes no eddy zone
{
  const ob = { id: 'm', x0: 150, x1: 154, y0: 21, y1: 27, top: 9, noEddy: true };
  const r = RFL.solve({ ...base, sections: vsecs(), obstructions: [ob], eddy: { on: true, er: 2, cr: 1 } }, 20);
  check('a strip of an imported model makes no eddy zone', r.eddyZones.length === 0 && !r.sections.some(s => s.eddies.length));
}

// 8g. A floating object: area beneath its draft, wetted underside, flow passing under
{
  const pts = rect(10, 0), secs = [section(0, pts), section(100, pts)];
  const float = { x0: 0, x1: 100, y0: 2, y1: 6, draft: 0.5 };
  const h = RFL.hydraulics(RFL.prepare({ sections: secs, floats: [float] }).preps[0], 2, 10);
  const h0 = RFL.hydraulics(RFL.prepare({ sections: secs }).preps[0], 2, 10);
  check('a floating object removes only the water beneath its draft', near(h.A, 10 * 2 - 4 * 0.5, 1e-9) && near(h.P - h0.P, 4 + 2 * 0.5, 1e-9), `area ${h.A.toFixed(3)} m², perimeter +${(h.P - h0.P).toFixed(3)} m`);
  const grounded = RFL.hydraulics(RFL.prepare({ sections: secs, floats: [{ ...float, draft: 5 }] }).preps[0], 2, 10);
  check('a float deeper than the water blocks down to the bed', near(grounded.A, 10 * 2 - 4 * 2, 1e-9), `area ${grounded.A.toFixed(3)} m²`);
  const f2 = { x0: 150, x1: 170, y0: 20, y1: 28, draft: 0.8 };
  const clear = RFL.solve({ ...base, sections: vsecs() }, 20), held = RFL.solve({ ...base, sections: vsecs(), floats: [f2] }, 20);
  const rise = RFL.wsAt(held, 200) - RFL.wsAt(clear, 200);
  check('a floating object raises the water upstream', rise > 0.001 && held.sections.some(s => Math.abs(s.x - 170) < 1e-6), mm(rise));
}

// 9. Yarnell's pier equation against a hand calculation
{
  // K 1.25, V 2 m/s, y 2 m, a 0.1: hv = 0.20387, w = 0.10194
  const hv = 4 / (2 * G), w = hv / 2;
  const hand = 2 * 1.25 * (1.25 + 10 * w - 0.6) * (0.1 + 15 * 1e-4) * hv;
  check('Yarnell matches the hand calculation', near(RFL.yarnell(1.25, 2, 2, 0.1), hand, 1e-12), `${mm(hand)}`);
}

// 10. Bridge: afflux, Yarnell check and the flow regime
{
  const br = { id: 'br', x: 150, length: 8, openLeft: 17, openRight: 31, lowChord: 2.4, highChord: 3.2, piers: [{ y: 24, width: 1 }], pierK: 0.9 };
  const lo = RFL.solve({ ...base, sections: vsecs(), bridges: [br] }, 20);
  const b = lo.bridges[0];
  check('bridge at low flow: afflux upstream', b.afflux > 0 && b.flow === 'low', `afflux ${mm(b.afflux)}, ${b.flow}`);
  check('bridge reports a Yarnell check', b.yarnell && b.yarnell.rise > 0, b.yarnell ? `Yarnell rise ${mm(b.yarnell.rise)}` : 'missing');
  const clear = RFL.solve({ ...base, sections: vsecs(), bridges: [{ ...br, openLeft: 0, openRight: 50, lowChord: 9, highChord: 10, piers: [] }] }, 20);
  check('a bridge that touches nothing has no afflux', Math.abs(clear.bridges[0].afflux) < 1e-4, `${mm(clear.bridges[0].afflux)}`);
  const hi = RFL.solve({ ...base, sections: vsecs(), bridges: [{ ...br, lowChord: 1.6, highChord: 4 }] }, 60);
  check('soffit below the water is flagged as pressure flow', hi.bridges[0].flow === 'pressure', hi.bridges[0].flow);
}

// 11. Bad input fails loudly
{
  check('NaN flow is refused', !!RFL.solve({ sections: vsecs() }, NaN).error);
  check('negative flow is refused', !!RFL.solve({ sections: vsecs() }, -5).error);
  check('one section is refused', !!RFL.solve({ sections: [vsec(0)] }, 10).error);
  const r = RFL.solve({ ...base, sections: vsecs() }, 40);
  check('buildings: depth over floor', near(RFL.buildings(r, [{ id: 'b', x: 150, floor: 1 }])[0].depth, RFL.wsAt(r, 150) - 1, 1e-12));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
