# Changelog

Every release of River Flow Lab, newest first. Each entry is a summary; the
release page linked from its heading has the full notes, and once a release is
archived on Zenodo its version DOI resolves to the archived copy of exactly
that build. To cite the software in general rather than one build, use the
concept DOI [10.5281/zenodo.24170674](https://doi.org/10.5281/zenodo.24170674).

## [1.0.0](https://github.com/arch85-km/river-flow-lab/releases/tag/v1.0.0) — 12 November 2026

Version DOI [10.5281/zenodo.24170675](https://doi.org/10.5281/zenodo.24170675)

The first release: a steady, one-dimensional river model for teaching what a
bridge, a wall, a building or a blockage does to a river. It is a teaching
model, not a flood risk assessment; `docs/method-notes.html` sets out the
method, its sources and its limits.

- **The water surface** for one steady flow, by the standard-step method,
  following HEC-RAS's steady-flow method: conveyance subdivision with
  Manning's equation, contraction and expansion losses, the energy method
  through a bridge with Yarnell's pier equation alongside, a broad-crested
  weir over an overtopped deck, and eddy zones sized by expansion and
  contraction ratios. Every result is read as a change against the same
  river without the design.
- **The river** from a template reach, a line drawn on the map or taken from
  OpenStreetMap, a terrain model (GeoTIFF, ASC or OBJ), or sections typed in.
- **The flow** from three buttons set from the river itself (Normal day,
  River full, Major flood), typed in with a climate allowance, or worked out
  from a float survey of the site.
- **The design**: obstructions, bridges with piers and abutments, flood walls,
  buildings, floating objects (by depth or weight, with a smooth hull) and
  imported 3D models.
- **The results**: water level, depth and speed at every section; the afflux,
  clearance and flow over the deck at each bridge; the depth over each
  building's floor; water level against flow; where the bed moves, builds up
  or is stable for a chosen bed material (Shields' threshold). Shown in 3D,
  Map, Plan, Section and Profile views; in 3D and Plan the water can be
  coloured by depth, speed or bed.
- **Exports**: the view as PNG, the results as CSV with the settings in its
  header, and the project as a file that opens again.
- **Basic and Advanced** levels, a guided tour, light and dark themes, and a
  layout for phones and embedded pages. Runs entirely in the browser, as a
  single file, with no installation or account.
