# Multipad Highway 3D

Multipad Highway 3D is a multipad-layout visualization for drum charts.
It displays ordinary `drum_highway_3d` piece ids through a front-facing
multipad layout instead of a single horizontal lane row. Any chart piece,
including hi-hat pedal and kick, may be assigned to a pad, a pedal surface, or
an external trigger; the default profile maps hi-hat pedal and kick to the top
and bottom pedal surfaces, but that's just a starting point, not a
restriction.

This directory currently contains the Phase 7 MVP renderer from
`PLANNING.md`:

- `plugin.json` declares a visualization provider only.
- `screen.js` registers `window.feedBackViz_multipad_highway_3d`, implements the
  WebGL2 host renderer lifecycle, and exposes tested pure helpers through
  `__test`.
- `screen.js` validates pad, pedal, and external-trigger profiles, routes
  drum-tab hits through `projectDrumTab`, preserves drum piece identity while
  applying pad/pedal/trigger routing, normalizes all articulations to plain
  multipad hits, groups same-window hits, and reads/writes localStorage-backed
  settings safely.
- The renderer builds the MVP 3x3 pad grid, per-pad tunnel guides, top/bottom
  pedal surfaces, side outline trigger surfaces, mirrored external trigger
  center/edge surfaces, pooled note meshes, timing-colored flashes, sparks,
  pedal pulses, background particles, and real `bundle.drumTab` rendering.
- Real feedpak drum hits are projected from the live `bundle.drumTab.hits`
  stream by object identity plus hit count, because the host appends
  `drum_hits` chunks into the same `drumTab` object as the song loads. A present
  empty `hits` array is treated as a real chart, not a reason to show demo hits.
- If a drum/percussion arrangement has no `bundle.drumTab`, the grid renders
  without invented notes.
- `settings.html` loads the plugin settings panel without depending on MIDI,
  WebGL, or runtime Tailwind. Pad assignments are shown as a grid matching the
  selected pad layout, with multi-piece pad assignments shown as chips.
- `assets/thumb.svg` provides the picker thumbnail.

Auto mode treats this standalone plugin as opt-in. When installed, it claims
drum/percussion arrangements with `has_drum_tab` even if the standard
`drum_highway_3d` renderer is also available, while guitar, bass, combo, and
keys arrangements keep their own visualizers.

## Layout Direction

The visual layout is an abstract m x n performance grid. The hit plane should
read as rectangular pads, with each pad extending backward into its own
tunnel. The MVP starts with a generic 3x3 pad profile, but the renderer should
remain open to layouts such as 2x4, 4x3, or 1x12 instead of treating 3x3 as the
plugin's permanent shape.

## Settings and Routing Notes

The settings panel edits direct assignments only:

- pads can contain one or more chart pieces, of any kind;
- pedals can map any single chart piece (not just `kick`/`hh_pedal`);
- external triggers can map chart pieces to off-grid trigger surfaces.

Any piece may be assigned to a pad, a pedal, or a trigger, but only one of
those at a time - a piece requested in more than one place across the
combined profile is kept on the first (pad, then pedal, then trigger) and
dropped from the rest, since a piece live on two targets would only ever
actually fire from one of them.

`Unmapped chart pieces` is a read-only status block. It lists pieces that are
not directly assigned to any pad, pedal, or trigger and updates when mappings
change.

Fallback routing is centralized in `screen.js`'s `buildPieceToPadMap()`. Profile
validation preserves sanitized explicit fallback overrides for compatibility,
but default fallback behavior is applied by the routing step.

Pad cells are positioned visually in the layout grid. Row/column wording is
reserved for accessibility labels.

## Development

`screen.js` is a **generated file** — the plugin loader still serves and
executes it as the single script named in `plugin.json`, but it's authored as
five files under `src/` (`01-constants.js`, `02-profiles.js`,
`03-projection.js`, `04-renderer.js`, `05-api.js`). Edit the file matching the
section you're touching, then rebuild:

```sh
plugins/multipad_highway_3d/build.sh
```

Commit the regenerated `screen.js` alongside your `src/` changes — CI's
`multipad-h3d-js-fresh` job rebuilds and diffs it, the same way the repo
root's `tailwind-fresh` job guards `static/tailwind.min.css`.

## Tests

```sh
node --test plugins/multipad_highway_3d/tests/*.test.js
```

## License

AGPL-3.0-only. See the repository root `LICENSE` for the full license text.
