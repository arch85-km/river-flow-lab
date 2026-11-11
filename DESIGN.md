# Design decisions

The decisions behind River Flow Lab, and my reasons for them.
[`ARCHITECTURE.md`](ARCHITECTURE.md) describes how the code is organised, and
[`docs/method-notes.html`](docs/method-notes.html) describes the methods and
their limits. This file records why the tool is the way it is. Written in
November 2026, at version 0.1.0, before the first release.

— Karam Al-Obaidi

## Why it exists

My students need to see what a bridge, a wall, a building or a blockage does
to a river on their own site, and none of the tools available to them fitted
that well:

- **Professional river models are too heavy.** HEC-RAS, Flood Modeller and
  InfoWorks ICM need installation, training and, for some, licences that most
  architecture students do not have.
- **Flood maps do not test designs.** The Environment Agency's Flood Map for
  Planning shows the existing risk, but it cannot show what a student's design
  would change.
- **Hand calculations are too abstract.** A Manning or weir calculation gives a
  number, but no picture, and not on the student's own site.
- **Students have no hydraulics background.** Architecture and urban design
  students rarely meet open-channel hydraulics, so they need an intuitive,
  visual way in.

## Why it runs in the browser

The tool is a single HTML file for the same reasons as my other teaching apps:

- **University-managed machines.** Nothing to install, no admin rights, no
  licences, nothing for IT to approve.
- **Any device, and embeddable.** It runs on students' own laptops, Mac or
  Windows, and sits inside my applications page on the web.
- **One family of apps.** It looks and behaves like my other teaching apps, so
  students who know one can find their way in another.

## Method

### A steady, one-dimensional model, following HEC-RAS

The water surface is solved by the standard-step method along one dimension,
for one steady flow, following HEC-RAS's steady-flow method. I chose this over
a two-dimensional or time-varying model for three reasons:

- **It is fast in a browser.** A steady 1D profile solves at once, so students
  can change a design and see its effect immediately.
- **It is a bridge to professional tools.** HEC-RAS is the standard 1D model;
  students who go on to use it meet the same concepts.
- **It teaches relationships.** A simple model shows cause and effect, such as
  water speeding through a narrow opening and backing up behind it, more
  clearly than a two-dimensional one.

### Flow buttons set from the river itself

The three flow buttons, Normal day, River full and Major flood, are set from
the river's own bankfull flow rather than from return periods:

- **It works immediately.** Students see results in the first minute, without
  first having to find a design flow for their site.
- **It scales to any river.** Anchored to the channel's own size, the buttons
  make sense on a stream and on a large river alike.
- **There is no hydrology in a browser.** Estimating a 1-in-100-year flow needs
  catchment data and methods, such as the Flood Estimation Handbook's, that the
  tool cannot carry.
- **Real flows are still possible.** A student with a real flow, or with a
  float survey of the site, can enter it.

The notes say plainly that the buttons are teaching anchors, not return
periods.

### Eddy zones made automatically

HEC-RAS asks the modeller to place ineffective flow areas behind a blockage.
Here the eddy zones are made automatically behind every blockage:

- **Students would not know to place them**, and without them the flow would
  pass through water that is really dead.
- **It makes flow separation visible.** Seeing the still water behind a
  blockage teaches separation, and where sediment settles.
- **They can be switched off.** In Advanced they can be resized, or turned off
  to compare.

## Teaching

I use the tool, or will, in undergraduate and postgraduate teaching, and in my
own research. Several features come directly from teaching:

- **Basic and Advanced.** Students start with plain words and fewer controls;
  the technical settings, results and terms are one switch away.
- **The guided tour.** Students need to know where to start, as in my other
  apps.
- **The float survey, speed colours and scour hints.** My brief asks students
  to describe how water moves through the channel at their site under low,
  typical and flood flow, using a simple survey, and to show where the flow
  speeds up, eddies, scours and settles. The float-survey helper, the water
  coloured by speed, and the hints on scour and settling support that brief.
- **Fewer settings.** The downstream boundary and the slider range were taken
  off the screen to keep the tool easy for students.

## What it deliberately leaves out

- **Rain and surface water.** Rainfall, drainage and surface-water flooding
  belong in other tools, not in a river tool.
- **Flood risk assessment.** It is not for planning, insurance or construction
  decisions; those need a validated model run by someone qualified to run it.
- **Sediment modelling.** Scour and settling stay hints, so students reason
  about them rather than read a number: read from the water speed, or, with
  the bed's material chosen, from whether the flow can move it. How deep the
  bed scours and how it changes are not modelled.
- **Accounts and cloud storage.** There is no log-in and no server storage;
  everything stays in the user's browser.

## How a release is checked

Before I teach with a release:

- **The automated suite must pass**: the engine and browser checks, run in a
  headless browser against the shipped file.
- **I use the live site myself**, as a student would.
- **I check it against the brief**: I run the module's own brief on a site and
  check that the outputs still make sense.

## Licensing and archiving

The code is MIT and the teaching material is CC BY 4.0, for the same reasons as
my other apps:

- **The code is free to reuse.** Anyone can adapt or embed it.
- **The material is reusable with credit.** Other educators can use the notes
  in their own courses, crediting the source.
- **Open licensing is expected** of this kind of work by my university or
  funders.

Every version will be archived on Zenodo with its own DOI:

- **Reproducible figures.** A reported number can be traced to the exact build
  that produced it.
- **A citable research output.** The software counts as an output in its own
  right.
- **A permanent archive.** Each version survives even if my website changes.
- **Credit when reused.** Anyone who uses it has a proper way to cite it.

## How this was developed

I designed the application. I defined the problem and the scope: what the tool
is for, who it is for and what it leaves out. I chose the methods and the
sources it relies on. I tested it in use, found and reported the bugs, judged
whether each fix worked, and decided what was released and when.

The code was written with an AI coding assistant, working to my specification
and direction. It wrote most of the code, drafted the documentation, which I
reviewed, diagnosed bugs and proposed fixes, which I then tested, and wrote and
ran the automated tests and release checks. I retain full intellectual
responsibility for the design, the methods and the results, including any
errors.

## Next

- **Time-varying flow**: a flood hydrograph, so that a short flood and a long
  one differ.
- **Culverts**, modelled rather than only named.
- **Exercises** in the method notes, as in my other apps.
- **Real-world validation**: a comparison with a gauged river, or with a
  HEC-RAS run of the same reach.
