# River Flood Lab

A single-file browser tool for teaching how river flow, water level,
obstructions and bridges interact, for architecture and urban design
students. The first site is a reach of the River Sheaf at Heeley,
Sheffield.

**Status: in development.** The engine and the interface work on a
template reach or on sections you type in. The River Sheaf site data and
the 3D view follow.

## Using it

Open `index.html` in a browser; it needs no installation, account or
network. It starts on a template reach (an idealised channel with
floodplains, not a survey) with one example bridge.

- **Flow:** drag the slider or type a flow; add a climate allowance in
  per cent.
- **Design elements:** add obstructions, bridges (soffit, deck, opening,
  piers), flood walls along a bank, and buildings with a floor level.
  Every result is compared with the same river without them.
- **Eddies:** mark the dead-water zones beside and behind obstructions and
  bridges, with the expansion and contraction ratios you choose.
- **Cross-section editor:** type ground points, banks and Manning's n for
  each section; widen the channel, add a berm, or change roughness.
- **Views:** plan, cross-section, long profile, and water level against
  flow at the chosen section.
- **Exports:** CSV, section PNG, and a project file to save and reopen.
  Every export carries the caution and the settings that produced it.

The only thing it stores in the browser is the colour theme
(`riverfloodlab.theme.v1`).

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

## Checks

```bash
npm test
```

`tests/engine.test.mjs` (27 checks) and `tests/ui.test.mjs` (57 checks,
headless Chromium; every off-origin request is refused). The engine checks compare the engine with closed-form results (Manning normal
depth, critical depth) and with an independent RK4 integration of the
gradually varied flow equation. Agreement shows the engine is consistent
with open-channel theory; it is not validation against measured levels.

## Licence

Code: MIT (see `LICENSE`). Documentation: CC BY 4.0.
