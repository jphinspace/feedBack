# Multipad Highway 3D

Multipad Highway 3D is a multipad-layout visualization for drum charts.
It displays ordinary `drum_highway_3d` piece ids through a front-facing
multipad layout instead of a single horizontal lane row. Hi-hat pedal and kick
hits are reserved for a separate pedal profile and render as top and bottom
pedal surfaces.

This directory currently contains the Phase 6 MVP renderer from
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
  pedal pulses, background particles, a demo fallback, and real
  `bundle.drumTab` rendering.
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

- pads can contain one or more non-pedal chart pieces;
- pedals can map `kick` and `hh_pedal`;
- external triggers can map non-pedal pieces to off-grid trigger surfaces.

`Unmapped chart pieces` is a read-only status block. It lists pieces that are
not directly assigned to any pad, pedal, or trigger and updates when mappings
change.

Fallback routing is centralized in `screen.js`'s `buildPieceToPadMap()`. Profile
validation preserves sanitized explicit fallback overrides for compatibility,
but default fallback behavior is applied by the routing step.

Pad cells are positioned visually in the layout grid. Row/column wording is
reserved for accessibility labels.

## Tests

```sh
node --test plugins/multipad_highway_3d/tests/*.test.js
```

## License

AGPL-3.0-only. See the repository root `LICENSE` for the full license text.
