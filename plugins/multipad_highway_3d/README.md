# Multipad Highway 3D

Multipad Highway 3D is a planned multipad-layout visualization for drum charts.
It displays ordinary `drum_highway_3d` piece ids through a front-facing
multipad layout instead of a single horizontal lane row. Hi-hat pedal and kick
hits are reserved for a separate pedal profile and will render as top and
bottom pedal indicators.

This directory currently contains the Phase 2 skeleton from `PLANNING.md`:

- `plugin.json` declares a visualization provider only.
- `screen.js` registers `window.feedBackViz_multipad_highway_3d` and returns a
  clean no-op renderer with `init`, `draw`, `resize`, and `destroy`.
- `settings.html` loads the plugin settings panel without depending on MIDI,
  WebGL, or runtime Tailwind.
- `assets/thumb.svg` provides the picker thumbnail.

The skeleton does not auto-claim arrangements yet. Auto mode will stay with
the existing drum, guitar, bass, and keys visualizers until the multipad data
projection and renderer phases are implemented.

## Layout Direction

The target visual is an abstract m x n performance grid. The hit plane should
read as rectangular pads, with each pad extending backward into its own
tunnel. The MVP starts with a generic 3x3 pad profile, but the renderer should
remain open to layouts such as 2x4, 4x3, or 1x12 instead of treating 3x3 as the
plugin's permanent shape.

## Tests

```sh
node --test plugins/multipad_highway_3d/tests/*.test.js
```

## License

AGPL-3.0-only. See the repository root `LICENSE` for the full license text.
