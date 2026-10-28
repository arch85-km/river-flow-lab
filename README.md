# River Flood Lab

A single-file browser tool for teaching how river flow, water level,
obstructions and bridges interact, for architecture and urban design
students. The first site is a reach of the River Sheaf at Heeley,
Sheffield.

**Status: in development.** The engine and the interface work on a
template reach or on sections you type in, with a 3D view. The River
Sheaf site data follows.

## Using it

Open `index.html` in a browser; it needs no installation, account or
network. The layout follows Urban Wind Lab: controls on the left, one large
view in the middle, results on the right. It starts on a template reach (an
idealised channel with floodplains, not a survey) with one example bridge.

- **Flow** (left): type or drag the flow, or pick Low, Bankfull or Twice
  bankfull (bankfull is found at the chosen section); add a climate
  allowance in per cent. The downstream boundary is folded away beneath.
- **Design** (left): add an obstruction, bridge, flood wall or building at
  the chosen section, then open it to set its size and levels. Eddy zones
  (the dead water beside and behind a blockage) can be resized or switched
  off.
- **River** (left): the active reach, a new template reach, and the
  cross-section editor.
- **Map** (middle): find a place (or type coordinates), press *Draw the
  river* in the River section, and click along the river from upstream to
  downstream. *Build reach from line* cuts sections square to the line at
  the spacing you set; the line's corners are rounded first, and on a bend
  each overbank gets its own reach length. The levels come from the
  template shape until surveyed levels are entered, and the reach says so.
- **Views** (middle): 3D, Map, Plan, Section and Profile, one at a time.
  On a drawn river the 3D view follows its course.
- **Results** (right): the legend for the view, tiles for the chosen
  section, the effect of the design (afflux, soffit clearance, floor levels,
  choking), water level against flow, and every section in a table.
- **File** menu: export the view as PNG, the results as CSV, and save or
  open a project. Every export carries the caution and the settings.

On a phone the view sits on top, with Controls and Results beneath.

## What it stores and what it contacts

- **Browser storage:** the colour theme (`riverfloodlab.theme.v1`) and, if
  you set one, a custom map tile service (`riverfloodlab.basemap.custom.v1`).
- **OpenStreetMap tiles** (`tile.openstreetmap.org`): the map area on
  screen, only while the Map view is open; at most 6 × 6 tiles, never
  prefetched. A custom tile service replaces them if you set one.
- **Nominatim** (`nominatim.openstreetmap.org`): the search text, only when
  you search for a place by name; typed coordinates are never sent. At most
  one request a second.
- Nothing else. Files you open are read in the browser and never uploaded.

**Teaching model — not a flood risk assessment.** Do not use its figures
for planning, insurance or construction decisions.

## Method

Steady, one-dimensional, subcritical flow, solved section by section with
the standard-step method (Chow 1959, ch. 10; HEC-RAS Hydraulic Reference
Manual, ch. 2 and 5):

- Manning friction with the section split into left overbank, channel and
  right overbank; average-conveyance friction slope; discharge-weighted
  reach lengths; contraction and expansion losses.
- **Obstructions** as blocked areas: the ground under them is raised, so
  the section loses area and gains wetted perimeter.
- **Bridges** by the energy method through the opening, with the soffit
  closing the section when the water reaches it (pressure flow) and
  overtopping flagged. Yarnell's pier equation is reported as a check.
  Afflux is measured against the same river without the bridge.
- **Eddy zones**: the dead water beside and behind an obstruction or
  bridge, sized by the expansion (1:ER) and contraction (1:CR) ratios and
  carrying no flow until the water rises above the blockage. The swirl
  inside them is not computed.
- Levees and ineffective areas carry no flow until overtopped.

## three.js

The 3D view uses three.js (MIT), bundled into `index.html` so the page
needs no network. To update it, change the pinned version in
`package.json`, then:

```bash
npm install
```

```bash
node tools/build-three.mjs
```

The licence notice is in `NOTICE`.

## Checks

```bash
npm test
```

`tests/engine.test.mjs` (27 checks) and `tests/ui.test.mjs` (160 checks,
headless Chromium with WebGL through SwiftShader; every off-origin
request is refused, except map tiles and place search, which are answered
from local fixtures in `tests/fixtures/`).

The engine checks compare the engine with closed-form results (Manning
normal depth, critical depth) and with an independent RK4 integration of the
gradually varied flow equation. Agreement shows the engine is consistent
with open-channel theory; it is not validation against measured levels.

## Licence

Code: MIT (see `LICENSE`). Documentation: CC BY 4.0.
