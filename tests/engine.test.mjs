// Engine checks for River Flow Lab.
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
  // The hull carries its own roughness, combined with the bed's by Horton's
  // rule: n = (Σ P n^1.5 / Σ P)^(2/3). Bed 14 m at n 0.03 (base 10 + walls 2 × 2),
  // hull 5 m (underside 4 + sides 2 × 0.5) at the default 0.013.
  const nE = Math.pow((14 * Math.pow(0.03, 1.5) + 5 * Math.pow(0.013, 1.5)) / 19, 2 / 3), Khand = 18 * Math.pow(18 / 19, 2 / 3) / nE;
  check('a hull\'s roughness joins the bed\'s by Horton\'s rule', near(h.K, Khand, 1e-9), `K ${h.K.toFixed(3)} against ${Khand.toFixed(3)} by hand, n ${nE.toFixed(4)}`);
  const same = RFL.hydraulics(RFL.prepare({ sections: secs, floats: [{ ...float, n: 0.03 }] }).preps[0], 2, 10);
  check('a hull as rough as the bed gives the plain Manning conveyance', near(same.K, 18 * Math.pow(18 / 19, 2 / 3) / 0.03, 1e-9));
  // A float only millimetres deep blocks almost nothing; what it adds is the
  // friction of its underside, like an ice cover, and a smooth hull adds far
  // less of that than a lid as rough as the river bed would.
  const filmRise = n => RFL.wsAt(RFL.solve({ ...base, sections: vsecs(), floats: [{ ...f2, draft: 0.003, n }] }, 20), 200) - RFL.wsAt(clear, 200);
  const smooth = filmRise(undefined), rough = filmRise(0.035);
  check('a smooth hull adds far less friction than a lid as rough as the bed', smooth > 0 && smooth < rough * 0.6 && smooth < rise / 10, `3 mm deep: ${mm(smooth)} smooth, ${mm(rough)} at bed roughness; ${mm(rise)} at 0.8 m deep`);
}

// 8h. A bridge with set abutments leaves the floodplain beyond them open
{
  const br = { id: 'br', x: 150, length: 8, openLeft: 17, openRight: 31, lowChord: 3.4, highChord: 4.2, piers: [] };
  const full = RFL.solve({ ...base, sections: vsecs(), bridges: [br], eddy: { on: false } }, 120), short = RFL.solve({ ...base, sections: vsecs(), bridges: [{ ...br, abut: 2 }], eddy: { on: false } }, 120);
  check('short abutments let the flood pass round them', RFL.wsAt(short, 200) < RFL.wsAt(full, 200) - 0.001, `${RFL.wsAt(full, 200).toFixed(3)} to ${RFL.wsAt(short, 200).toFixed(3)} m`);
}

// 8i. Low ground behind a ridge carries no flow until the water tops the ridge
{
  const pts = [[0, 5], [5, 1.5], [10, 1.5], [12, 3], [14, 3], [16, 0], [24, 0], [26, 3], [40, 3.2]];
  const s = { id: 'r', x: 0, pts, n: { lob: 0.05, ch: 0.05, rob: 0.05 }, banks: { left: 14, right: 26 } };
  const p = RFL.prepare({ sections: [s, { ...s, x: 50 }] }).preps[0];
  const low = RFL.hydraulics(p, 2, 10), channel = RFL.wetted(pts, 2, 12, 40);
  check('water behind a ridge carries no flow', near(low.A, channel.A, 1e-9), `area ${low.A.toFixed(3)} m\u00b2`);
  const high = RFL.hydraulics(p, 3.5, 10), all = RFL.wetted(pts, 3.5, 0, 40);
  check('water above the ridge joins the river', near(high.A, all.A, 1e-9), `area ${high.A.toFixed(3)} m\u00b2`);
}

// 8j. A building behind a wall stays dry until the wall is overtopped
{
  const secs = vsecs(), wall = { side: 'left', x0: 0, x1: 300, y: 15, z: 3 };
  const r = RFL.solve({ ...base, sections: secs, walls: [wall] }, 80), level = RFL.wsAt(r, 100);
  const [b] = RFL.buildings(r, [{ id: 'h', x: 100, y: 8, floor: level - 0.5 }]);
  check('a building behind a wall is dry while the wall holds', level < 3 && b.cutOff && b.depth <= 0, `water ${level.toFixed(2)} m`);
}

// 8z. The force on the bed, and the force needed to move its grains
{
  // In uniform flow the friction slope is the bed slope, so the bed force is
  // rho g R S at normal depth: rectangle 10 m wide, n 0.03, S 0.001, 20 m³/s.
  const b = 10, n = 0.03, S = 0.001, Q = 20;
  const prep = RFL.prepare({ sections: [section(0, rect(b, 0), n), section(10, rect(b, 0.01), n)] }).preps[0];
  const y = RFL.normalWS(prep, Q, S), h = RFL.hydraulics(prep, y, Q);
  const hand = 1000 * 9.81 * (b * y / (b + 2 * y)) * S;
  check('bed force in uniform flow is rho g R S', near(RFL.bedShear(h), hand, 1e-6), `${RFL.bedShear(h).toFixed(4)} N/m² against ${hand.toFixed(4)} by hand`);
  // Shields' threshold with Soulsby's fit, by hand for 4 mm quartz grains in water
  const d = 0.004, Dstar = d * Math.cbrt(1.65 * 9.81 / 1e-12), theta = 0.30 / (1 + 1.2 * Dstar) + 0.055 * (1 - Math.exp(-0.020 * Dstar));
  check('threshold to move 4 mm gravel matches a hand calculation', near(RFL.criticalShear(d), theta * 1.65 * 1000 * 9.81 * d, 1e-9), `${RFL.criticalShear(d).toFixed(3)} N/m², Shields parameter ${theta.toFixed(4)}`);
  const sizes = [0.0002, 0.0007, 0.004, 0.03, 0.1].map(RFL.criticalShear);
  check('coarser grains need more force, from fine sand to cobbles', sizes.every((t, i) => !i || t > sizes[i - 1]), sizes.map(t => t.toFixed(2)).join(' < ') + ' N/m²');
  check('a dry channel has no bed force', RFL.bedShear({ sub: { ch: { A: 0, P: 0, K: 0, Q: 0 } } }) === null);
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
  const hi = RFL.solve({ ...base, sections: vsecs(), bridges: [{ ...br, lowChord: 1.6, highChord: 6 }] }, 60);
  check('soffit below the water is flagged as pressure flow', hi.bridges[0].flow === 'pressure', `${hi.bridges[0].flow}; upstream ${hi.bridges[0].wsUpstream.toFixed(3)} m, deck ${hi.bridges[0].highChord} m, weir ${(hi.bridges[0].weirFlow || 0).toFixed(2)} of 60 m3/s`);
}

// 11. Bad input fails loudly
{
  check('NaN flow is refused', !!RFL.solve({ sections: vsecs() }, NaN).error);
  check('negative flow is refused', !!RFL.solve({ sections: vsecs() }, -5).error);
  check('one section is refused', !!RFL.solve({ sections: [vsec(0)] }, 10).error);
  const r = RFL.solve({ ...base, sections: vsecs() }, 40);
  check('buildings: depth over floor', near(RFL.buildings(r, [{ id: 'b', x: 150, floor: 1 }])[0].depth, RFL.wsAt(r, 150) - 1, 1e-12));
}

// Afflux is the biggest rise upstream of a bridge, not the level at the next
// section, which can sit in the drawdown as the flow speeds up into the opening.
{
  const sec = x => {
    const b = 100 - 0.001 * x;
    return { id: 's' + x, x, pts: [[0, b + 3], [100, b + 2], [101, b], [121, b], [122, b + 2], [222, b + 3]],
      banks: { left: 101, right: 121 }, n: { lob: 0.06, ch: 0.035, rob: 0.06 } };
  };
  const sections = []; for (let x = 0; x <= 1000; x += 15) sections.push(sec(x));
  const model = { sections, boundary: { type: 'normal', slope: 0.001 }, obstructions: [], walls: [] };
  const bridge = { id: 'A', x: 495, length: 10, lowChord: 104, highChord: 105, openLeft: 101, openRight: 121, piers: [{ y: 111, width: 2 }] };
  const Q = 150;
  const withBridge = RFL.solve({ ...model, bridges: [bridge] }, Q);
  const without = RFL.solve({ ...model, bridges: [], stations: withBridge.sections.map(s => s.x) }, Q);
  const peak = Math.max(...withBridge.sections.filter(s => s.x > 505).map(s => s.ws - RFL.wsAt(without, s.x)));
  check('afflux is the biggest rise upstream of the bridge', Math.abs(withBridge.bridges[0].afflux - peak) < 1e-6,
    `afflux ${mm(withBridge.bridges[0].afflux)}, biggest rise ${mm(peak)}`);
  const second = { ...bridge, id: 'B', x: 800, lowChord: 103, highChord: 104 };
  const both = RFL.solve({ ...model, bridges: [bridge, second] }, Q);
  const a = both.bridges.find(b => b.id === 'A').afflux;
  check('a second bridge upstream does not add to this bridge\'s afflux', Math.abs(a - peak) < 0.02, `afflux ${mm(a)}, alone ${mm(peak)}`);
}

// A bridge deck limits the water only where the deck is: past short
// abutments the floodplain is open to the sky.
{
  const sec = x => ({ id: 's' + x, x, pts: [[0, 103], [100, 102], [101, 100], [121, 100], [122, 102], [222, 103]],
    banks: { left: 101, right: 121 }, n: { lob: 0.06, ch: 0.035, rob: 0.06 } });
  const sections = [sec(0), sec(100), sec(200)];
  const deck = { id: 'D', x: 100, length: 10, lowChord: 103.5, highChord: 104.5, openLeft: 101, openRight: 121, piers: [] };
  const atBridge = abut => RFL.prepare({ sections, bridges: [{ ...deck, abut }] }).preps.find(p => p.bridge);
  const ws = 104, Q = 300;
  const short = atBridge(5), open = RFL.hydraulics({ ...short, ceil: undefined, bridge: null }, ws, Q);
  const under = RFL.hydraulics(short, ws, Q);
  check('the deck does not limit water beyond short abutments',
    Math.abs(under.sub.lob.A - open.sub.lob.A) < 1e-6 && Math.abs(under.sub.rob.A - open.sub.rob.A) < 1e-6,
    `left floodplain ${under.sub.lob.A.toFixed(1)} m2, open ${open.sub.lob.A.toFixed(1)} m2`);
  check('the deck still limits water over the opening', under.sub.ch.A < open.sub.ch.A - 1,
    `channel ${under.sub.ch.A.toFixed(1)} m2, open ${open.sub.ch.A.toFixed(1)} m2`);
  const full = atBridge(undefined);
  check('with full-width abutments only the opening carries water',
    Math.abs(RFL.hydraulics(full, ws, Q).A - RFL.hydraulics(full, 103.6, Q).A) < 1e-6 && RFL.hydraulics(full, ws, Q).sub.lob.A === 0,
    `area ${RFL.hydraulics(full, ws, Q).A.toFixed(1)} m2`);
}

// A wall protects a building only at the wall's own chainage, and water can
// come round an open end across a wet floodplain.
{
  const sec = (x, high) => {
    const b = 100 - 0.001 * x, f = high ? 20 : 2;
    return { id: 's' + x, x, pts: [[0, b + f + 1], [100, b + f], [101, b], [121, b], [122, b + f], [222, b + f + 1]],
      banks: { left: 101, right: 121 }, n: { lob: 0.06, ch: 0.035, rob: 0.06 } };
  };
  const secs = high => { const a = []; for (let x = 0; x <= 1000; x += 100) a.push(sec(x, high(x))); return a; };
  const run = (walls, high = () => false) => RFL.solve({ sections: secs(high), boundary: { type: 'normal', slope: 0.001 }, walls, obstructions: [], bridges: [] }, 1500);
  const house = (x, y = 50) => ({ id: 'H', x, y, floor: 101 });
  const wall = (x0, x1, side = 'left') => ({ side, x0, x1, y: side === 'left' ? 95 : 128, z: 115 });

  const pastEnd = RFL.buildings(run([wall(90, 110)]), [house(145)])[0];
  check('a building past the end of a wall is not protected by it', !pastEnd.cutOff && pastEnd.depth > 1, `depth ${pastEnd.depth.toFixed(2)} m`);

  const round = RFL.buildings(run([wall(350, 650)]), [house(500)])[0];
  check('water comes round the open end of a short wall', !round.cutOff && round.flanked && round.depth > 1, `depth ${round.depth.toFixed(2)} m`);

  const tied = RFL.buildings(run([wall(130, 1000)], x => x <= 100), [house(140)])[0];
  check('a wall tied into high ground protects a building nearer the section beyond its end', tied.cutOff && !tied.flanked && tied.depth <= 0, `depth ${tied.depth.toFixed(2)} m`);

  const whole = RFL.buildings(run([wall(0, 1000)]), [house(500)])[0];
  check('a wall along the whole reach still protects the building behind it', whole.cutOff && !whole.flanked && whole.depth <= 0, `depth ${whole.depth.toFixed(2)} m`);

  const otherBank = RFL.buildings(run([wall(0, 1000, 'right')]), [house(500)])[0];
  check('a wall on the other bank does not protect the building', !otherBank.cutOff && otherBank.depth > 1, `depth ${otherBank.depth.toFixed(2)} m`);

  const joined = RFL.buildings(run([wall(0, 450), wall(450, 1000)]), [house(200)])[0];
  check('walls joined end to end have no open end between them', joined.cutOff && !joined.flanked, `depth ${joined.depth.toFixed(2)} m`);
}

// Water over a bridge deck flows as a broad-crested weir, sharing the flow
// with the opening (HEC-RAS Hydraulic Reference Manual, ch. 5).
{
  // a valley whose sides stand well above any flood here
  const ground = [[0, 12], [10, 3], [100, 2], [101, 0], [121, 0], [122, 2], [212, 3], [222, 12]];
  const sec = x => {
    const b = 100 - 0.001 * x;
    return { id: 's' + x, x, pts: ground.map(([y, z]) => [y, b + z]), banks: { left: 101, right: 121 }, n: { lob: 0.06, ch: 0.035, rob: 0.06 } };
  };
  const sections = []; for (let x = 0; x <= 1000; x += 20) sections.push(sec(x));
  const deck = { id: 'W', x: 500, length: 10, lowChord: 103.5, highChord: 104.5, openLeft: 101, openRight: 121, piers: [] };
  const run = (Q, boundary = { type: 'normal', slope: 0.001 }, eddy = { on: true }) => RFL.solve({ sections, boundary, bridges: [deck], walls: [], obstructions: [], eddy }, Q);
  const bigRun = run(1600), big = bigRun.bridges[0];
  const C = 1.44, crest = 104.5;
  // Villemonte (1947), and the weir summed over 0.01 m strips across the
  // natural ground at the bridge, written out here independently of the engine.
  const drowning = (head, tailOver) => tailOver <= 0 ? 1 : tailOver >= head ? 0 : Math.pow(1 - Math.pow(tailOver / head, 1.5), 0.385);
  const handWeir = (level, tail) => {
    const b = 100 - 0.001 * 510, z = y => { for (let i = 1; i < ground.length; i++) if (y <= ground[i][0]) { const [y0, z0] = ground[i - 1], [y1, z1] = ground[i]; return b + z0 + (z1 - z0) * (y - y0) / (y1 - y0); } return b + 12; };
    let q = 0; for (let y = 0.005; y < 222; y += 0.01) { const top = Math.max(crest, z(y)), H = level - top; if (H > 0) q += C * Math.pow(H, 1.5) * drowning(H, tail - top) * 0.01; }
    return q;
  };
  check('a flood over a deck reaches a plausible level', big.flow === 'overtopping' && big.wsUpstream < 109, `upstream ${big.wsUpstream.toFixed(2)} m, deck 104.5 m`);
  const expected = handWeir(crest + big.weirHead, big.wsDownstream);
  check('flow over the deck follows the weir equation', big.weirFlow > 0 && Math.abs(big.weirFlow - expected) < 0.01 * expected, `${big.weirFlow.toFixed(1)} m3/s, hand ${expected.toFixed(1)}, head ${big.weirHead.toFixed(3)} m, water below ${(big.wsDownstream - crest).toFixed(3)} m over the deck`);
  check('opening and weir share the whole flow', Math.abs(big.weirFlow + big.openingFlow - 1600) < 1e-6, `${big.openingFlow.toFixed(1)} + ${big.weirFlow.toFixed(1)}`);
  check('a bridge not overtopped has no weir flow', run(100).bridges[0].weirFlow === 0);
  // eddy zones off: they switch on and off as the deck is reached, a separate effect
  const levels = []; for (let Q = 100; Q <= 700; Q += 10) levels.push(run(Q, undefined, { on: false }).bridges[0].wsUpstream);
  const jump = Math.max(...levels.slice(1).map((v, i) => Math.abs(v - levels[i])));
  const at = levels.findIndex((v, i) => i > 0 && Math.abs(v - levels[i - 1]) === jump);
  check('the level does not jump when the deck starts to overtop', jump < 0.3, `largest step ${jump.toFixed(3)} m for 10 m3/s, at ${100 + 10 * at} m3/s`);
  const dip = levels.findIndex((v, i) => i > 0 && v < levels[i - 1] - 1e-6);
  check('the level rises steadily with the flow', dip < 0, dip < 0 ? '' : `falls at ${100 + 10 * dip} m3/s: ${levels[dip - 1].toFixed(3)} to ${levels[dip].toFixed(3)} m`);
  // with eddy zones on: the dead water below the bridge clears gradually as the water rises over the deck
  const withEddies = []; for (let Q = 100; Q <= 700; Q += 20) withEddies.push(run(Q).bridges[0].wsUpstream);
  const eddyJump = Math.max(...withEddies.slice(1).map((v, i) => Math.abs(v - withEddies[i])));
  const eddyDip = withEddies.findIndex((v, i) => i > 0 && v < withEddies[i - 1] - 1e-6);
  check('with eddy zones on the level rises steadily with the flow', eddyDip < 0, eddyDip < 0 ? '' : `falls at ${100 + 20 * eddyDip} m3/s: ${withEddies[eddyDip - 1].toFixed(3)} to ${withEddies[eddyDip].toFixed(3)} m`);
  check('with eddy zones on the level does not jump', eddyJump < 0.25, `largest step ${eddyJump.toFixed(3)} m for 20 m3/s`);
  const free = big, highTail = bigRun.sections[0].ws + 1.5;
  const drowned = run(1600, { type: 'ws', ws: highTail }).bridges[0];
  const freeFormula = handWeir(crest + drowned.weirHead, -Infinity);
  check('a higher water level below the bridge drowns the weir', drowned.weirFlow < freeFormula - 1 && drowned.wsUpstream > free.wsUpstream, `${drowned.weirFlow.toFixed(1)} against ${freeFormula.toFixed(1)} m3/s free; upstream ${drowned.wsUpstream.toFixed(2)} against ${free.wsUpstream.toFixed(2)} m`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
