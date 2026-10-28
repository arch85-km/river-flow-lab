# River Flood Lab

A single-file browser tool for teaching how river flow, water level,
obstructions and bridges interact, for architecture and urban design
students. The first site is a reach of the River Sheaf at Heeley,
Sheffield.

**Status: in development.** The hydraulic engine is in place and tested;
the interface, the site data and the 3D view follow.

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

The checks compare the engine with closed-form results (Manning normal
depth, critical depth) and with an independent RK4 integration of the
gradually varied flow equation. Agreement shows the engine is consistent
with open-channel theory; it is not validation against measured levels.

## Licence

Code: MIT (see `LICENSE`). Documentation: CC BY 4.0.
