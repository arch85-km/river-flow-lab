# Architecture

How River Flow Lab is put together: what lives where, how a calculation
flows through the code, and what the tooling around it does. For *why* the
methods were chosen and what they do not model, read the README's method
section (the method notes follow); this file is the map, not the argument.

## One file

The whole application is `index.html`, about 0.85 MB, with no build step for
the person using it and nothing fetched at start-up. It opens from a web
server or from disk.

| Part of `index.html` | Size | What it is |
|---|---|---|
| `<head>`: a small theme script and one `<style>` block | ~16 kB | Reads the saved theme before the page draws; the dark and light themes and the layout |
| `<body>` markup | ~19 kB | The three columns: controls, the view, results |
| `<script id="rfl-three">` | ~562 kB | three.js 0.186.1, only the parts the page uses, minified, exposed as `window.RFL_THREE`. Between the `three:start` and `three:end` markers, written by `tools/build-three.mjs` |
| `<script id="rfl-engine">` | ~33 kB | The hydraulic engine, `RFL`. No access to the page: it takes a model and a flow and returns numbers, so the tests and the rating-curve worker run it on its own |
| `<script id="rfl-ui">` | ~224 kB | The application: state, views, editors, files, map, 3D |

## Conventions

- **Chainage `x`** in metres, measured **upstream from the downstream end**
  of the reach. Sections are kept sorted by `x`.
- **Offset `y`** in metres across a section, increasing from the **left bank
  to the right bank looking downstream**. A section's ground is a list of
  `[y, level]` points, left to right.
- Levels in metres. A reach built from British National Grid terrain is in
  m AOD and says so; a template or drawn reach is in metres above an
  arbitrary datum.
- Flow in m³/s. The flow used is the set flow times `1 + allowance / 100`
  (`flowQ`).
- 3D scene: Y up. A reach with a place on the map has **+X east and −Z
  north**, so it sits as on the map; a reach without one runs along X.
  Heights are multiplied by the vertical exaggeration.
- The version is the `VERSION` constant at the top of the application
  script and `version` in `package.json`, both 0.1.0. Nothing yet holds
  them together (see Testing and release).

## The calculation chain

`RFL` (in `rfl-engine`) is one module returning its API. Its parts, named as
in the source so they can be found by search:

| Part | What it does | Method and source |
|---|---|---|
| `clip`, `raise`, `applyBlock`, `groundAt` | Ground-line geometry: part of a line, a line raised to a level, a blocked obstruction | HEC-RAS "blocked obstruction": area removed, its sides become wetted perimeter |
| `wetted`, `wettedAtDeck` | Area, wetted perimeter and top width of the water between two offsets; a bridge soffit caps the water only under the deck | Trapezoid sums over the ground line; pressure flow where the soffit is touched |
| `hydraulics` | One section at one water level: left overbank, channel and right overbank as subdivisions, each with its own conveyance; levees and ineffective areas excluded until overtopped; low ground cut off behind natural high ground excluded (`cutOff`); eddy zones as dead water below the blockage top, with the layer above it as its own subdivision; floating objects, their underside and sides wetted perimeter at hull roughness (`HULL_N`, 0.013 unless the object gives its own `n`); vertical walls at the ends of the ground line | Manning, conveyance subdivision, velocity-head coefficient α (Chow 1959; HEC-RAS Hydraulic Reference Manual, ch. 2); bed and hull roughness combined by Horton's composite n (HEC-RAS ch. 2) |
| `criticalWS`, `normalWS`, `bisect` | Critical water level (least specific energy: a scan, then golden-section refinement, memoised) and normal depth | Chow 1959 |
| `prepare` | Turns the model into prepared sections: adds interpolated sections where a blockage, eddy zone, wall, floating object or requested station needs one (`sectionAt`, `interpolateSection`); applies blocks, flood walls (`withWalls`) and eddy zones (`eddySpan`, `eddyLength`) | Eddy zones sized by the expansion (1:ER) and contraction (1:CR) ratios, HEC-RAS ch. 5 |
| `solve` | The water profile, section by section from the downstream boundary upwards (`stepUp`): energy equation, average-conveyance friction slope, discharge-weighted reach length, contraction and expansion losses; critical depth where no subcritical answer exists | Standard step, HEC-RAS ch. 2 |
| Bridge crossing in `solve`, `weirFlow` | Across a bridge the flow through the opening and over the deck are balanced so both give the same level at the section upstream | Energy method through the opening; broad-crested weir over the deck, coefficient 1.44, drowned after Villemonte (1947); HEC-RAS ch. 5 |
| `bridgeReport`, `affluxAbove`, `yarnell` | Per bridge: afflux (the biggest rise above the same river without bridges, from the upstream face to the next bridge), soffit clearance, flow regime, weir and opening flow, Yarnell's pier rise as a check | Yarnell's pier equation, HEC-RAS ch. 5 |
| `buildings`, `wallGuard`, `isCutOff` | Depth over each building's floor; dry if cut off behind natural ground or behind a holding wall at its own chainage, unless water can come round an open end of the wall | 1D: water round a wall end is judged from the floodplain just past the end |
| `wsAt` | Water level at any chainage, linear between sections | |

Default coefficients: contraction 0.1 and expansion 0.3, and 0.3 and 0.5
next to a bridge; eddy zones on, CR 1, ER 2.

### A run end to end

1. A change (a slider, an editor, a drag) calls `schedule`, which runs
   `run` on the next animation frame, so a burst of changes runs once.
2. `run` refreshes the overbank reach lengths on a bend (`bendLengths`) when
   the reach has a place on the map, then takes the flow from `flowQ`.
3. `model(true)` turns the state `S` into an engine model: sections, the
   downstream boundary, eddy settings, floating objects (`floatBoxes`),
   obstructions (with imported models as solid strips, `solidBlocks`),
   bridges (piers parsed by `parsePiers`) and flood walls (side from
   `wallSide`). `model(false)` is the same river with no design elements.
4. `RFL.solve(model(true), Q)` gives `RES`. When there is a design,
   `RFL.solve(model(false), …)` with `RES`'s chainages as stations gives
   `BASE`, so the two compare section by section.
5. Inside `solve`: `prepare`, the downstream level (`normalWS` from the
   boundary slope, or the fixed level, never below critical), then
   `stepUp` up the reach, the bridge crossings, a bridge-free run for
   afflux, and `bridgeReport` for each bridge.
6. `run` then draws: `renderFlow`, `renderPills`, `renderHeadline`,
   `renderStatus` (the result chips, including buildings from
   `RFL.buildings`), `renderViewPicker`, `renderTiles`, `renderRiver`,
   `renderActive` (only the view on screen), `renderTable`, and
   `scheduleRating`.
7. The rating curve (`renderRating`) waits 180 ms, then solves 28 flows in
   equal steps up to the largest, with and without the design, in a Web Worker made
   from the engine's own script (`chartWorker`), so the page stays
   responsive.

## Interaction and drawing

- **Basic and Advanced**: `level`, from the Advanced button or `#advanced` on
  the address. `T(technical, plain)` picks the wording; `.rf-adv` and
  `.rf-basic` elements show in one level only.
- **Views**, drawn only when on screen (`drawActive`): 3D (`build3D`), Map
  (`renderMap`), Plan (`renderPlan`), Section (`renderSection`), Profile
  (`renderProfile`). Plan, Section and Profile are SVG. "With design" and
  "Without" switch the view between `RES` and `BASE` (`before`,
  `renderActive`).
- **3D**: three.js with OrbitControls, in `V3`. Each rebuild removes and
  disposes every object it made (`clear3D`). Elements can be dragged in the
  3D view (`ray3D`, `groundUnder`); an imported model turns with its
  Rotation slider.
- **Editors**: design elements (obstructions, bridges, flood walls,
  buildings, floating objects, imported OBJ models up to 30,000 triangles)
  in the element list; one section at a time in "Fine-tune one section
  (optional)", Advanced only.
- **New rivers**: `shapeDialog` sets depth, bank slope, bed width and, in
  Advanced, fall, floodplains and roughness, for a new template reach
  (`templateSections`) or along a line drawn on the map
  (`reachFromLine`). `terrainDialog` and `terrainReach` build a reach from
  a terrain model.
- **Files**: save and open a project (`river-flow-lab-project.json`,
  checked whole by `validState` before anything changes); CSV of the
  results; PNG of the view, the map or the 3D view, each with a footer of
  the settings and the caution.

## Site, map and terrain

- **Terrain models**: GeoTIFF (`parseTiff`, 32-bit float, uncompressed or
  LZW, up to 26 million cells), ESRI ASCII grids (`parseAsc`, several tiles
  joined by `gridTerrain`, up to 64 million cells together) and OBJ meshes
  (`makeTerrain`); files over 400 MB together are refused
  (`importTerrain`). A GeoTIFF's declared grid is read by
  `gridFromTiffTags`; anything not in British National Grid, or outside its
  range, is not placed on the map. `terrainReach` cuts sections square to
  the clicked line, carves a channel of the given depth and width unless the
  model holds the real bed, and crosses short gaps in the data.
- **Distances on the map** use the WGS84 length of a degree at the latitude
  (`kLat`, `kLon`); terrain lines are kept in metres. British National Grid
  conversion: `bngToWgs`, `wgsToBng`.
- **Network requests**, all on a user's action; nothing at start-up:

| Request | When |
|---|---|
| Map tiles, OpenStreetMap or a custom tile service | Only while the Map view is open, or when a map button is pressed; fetched for the visible area only |
| Nominatim place search | On Search with words; typed coordinates are never sent; at most one request a second |
| Overpass, through `server/overpass-proxy.php` | On "Find rivers here": the page asks the proxy on its own site first (beside the page or at the top of the site) |
| Overpass public servers | When the proxy is absent or down: two servers in turn, with retries |

- **What the browser stores** (`localStorage`):

| Key | Holds |
|---|---|
| `riverflowlab.theme.v1` | Light, dark or automatic |
| `riverflowlab.basemap.custom.v1` | A custom tile service: URL template, credit, maximum zoom |

Projects and terrain files stay in the browser; nothing is uploaded.

## The repository

```
index.html                     the application
README.md                      what it is, how to use it, the method in brief
NOTICE                         the two licences (MIT code, CC BY 4.0 documentation) and three.js's notice
LICENSE                        MIT, for the code
package.json, package-lock.json  test and build dependencies: esbuild, three
server/overpass-proxy.php      same-site proxy and 30-day cache for OpenStreetMap waterways
tests/engine.test.mjs          engine checks against closed-form results and an independent integration
tests/ui.test.mjs              the page in headless Chromium, both themes, four sizes
tests/overpass-proxy.mjs       the proxy under php -S against a stand-in Overpass
tests/fixtures/                a tile image and a synthetic Overpass answer
tools/build-three.mjs          bundles three.js into index.html
tools/three-entry.js           the parts of three.js the page uses
```

## Testing and release

```bash
npm test
```

runs the three suites. At this version: `tests/engine.test.mjs` 65 checks,
`tests/ui.test.mjs` 252 checks, `tests/overpass-proxy.mjs` 19 checks (skipped
where PHP is not installed). The engine checks compare with closed-form
results (normal and critical depth), an independent RK4 integration of the
gradually varied flow equation, and hand calculations (Yarnell, the weir
over a deck); agreement shows the engine is consistent with open-channel
theory, not that it matches measured river levels. The UI checks run with
WebGL through SwiftShader and refuse every request off the page's origin
except the map tiles, place search and Overpass, which come from fixtures.

The app has not been released. There is no `CITATION.cff`, `.zenodo.json`,
`CHANGELOG.md` or release guard yet; they come with the first release.
