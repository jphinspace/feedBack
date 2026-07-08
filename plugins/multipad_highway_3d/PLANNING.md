# Multipad Highway 3D Plugin Plan

![3x3 matrix note highway wireframe](assets/multipad_3x3_highway_wireframe.png)

Design reference: the MVP visual direction is a front-facing 3x3 pad matrix
where each pad extrudes backward into its own tunnel. The longer-term
visual model should support m x n multipad layouts. Notes should remain inside
their assigned pad, including simultaneous hits, rather than becoming a
single horizontal row of separate lanes.

Highway/tunnel reference: the receding 3D highway, tunnel depth, note travel,
camera feel, lighting language, and general motion style should match the
existing `drum_highway_3d` and guitar/bass `highway_3d` plugins as much as
possible. The new visual work is the front hit plane: a multipad surface grid
plus pedal surface behavior.

Mockup interpretation: treat the image as an abstract MVP performance grid, not
a literal Alesis Strike MultiPad physical layout or a permanent 3x3-only
constraint. The default MVP pad profile should be a generic 3x3 pad layout;
future profiles may use other m x n multipad shapes. `kick` and `hh_pedal`
hits should be handled by a separate default pedal profile, then represented
as bottom and top outline surfaces around the active multipad grid.
The play surface is a front-facing hit plane made of rectangular pads,
while the depth behind it provides the highway/tunnel perspective.
Same-time labels in the mockup should become "hit group" in production docs and
UI, meaning multiple drum hits scheduled at the same time. Positional labels in
the mockup are noncanonical placeholders; real labels should come from the same
drum piece labels/routing already used by `drum_highway_3d`.

## 1. Best Practices for Developing Plugins for This Repository

Use the bundled plugins as the primary shape guide before writing new code. For this plugin, the closest local references are `plugins/drum_highway_3d`, `plugins/highway_3d`, and `plugins/keys_highway_3d`; useful upstream references include `got-feedBack/feedBack`, `got-feedBack/feedBack-plugin-drums`, `got-feedBack/feedBack-plugin-keys-highway-3d`, and `got-feedBack/feedBack-plugin-editor`.

Avoid reinventing the wheel. If `drum_highway_3d`, `highway_3d`, `keys_highway_3d`, core highway code, or capability domains already solve a behavior, reuse or adapt that implementation instead of duplicating it. New code in this plugin should be limited to the multipad-specific hit plane, pedal surface presentation, and the minimal glue needed to render existing drum data through that presentation.

Keep the plugin contract boring and explicit. A visualization plugin should declare `type: "visualization"` in `plugin.json`, register `window.feedBackViz_multipad_highway_3d`, and return a renderer object with the host `setRenderer` lifecycle: `init(canvas, bundle)`, `draw(bundle)`, `resize(w, h)`, and `destroy()`. Add `contextType: "webgl2"` when the renderer needs WebGL2. Because this plugin is planned as a standalone opt-in install rather than a default bundled visualizer, `matchesArrangement(songInfo)` may claim drum/percussion charts even when `drum_highway_3d` is also available; it must still stay narrow enough that Auto mode does not steal guitar, bass, combo, or keys arrangements from their own visualizers.

Prefer capability domains over private browser APIs when the plugin eventually owns input or scoring behavior. MIDI should go through the core `midi-input` domain as a requester, mirroring `drum_highway_3d` and the upstream 2D drums plugin. If the plugin later emits scored hits/misses, declare and implement the relevant `note-detection` behavior rather than using an untracked window-global side channel. For the MVP, prioritize the UI/visualization path and avoid new MIDI or note-detection claims.

Treat the highway bundle as read-only. For drum charts, consume `bundle.drumTab` and do not decode guitar-style `bundle.notes`; `static/highway.js` streams drum tab metadata and chunked hits from the server, and `lib/drums.py` is the canonical vocabulary for piece ids, default GM MIDI notes, categories, shapes, colors, presets, and wire normalization.

Make renderer state instance-safe. Splitscreen and renderer rehydration mean a plugin can be initialized more than once. Keep per-renderer scene state inside the factory instance, use module-level singletons only for browser-unique resources such as MIDI access or shared audio samples, and make every async open/connect path generation-safe so a late result cannot reattach a destroyed renderer.

Keep the draw path disciplined. Avoid per-frame DOM queries, broad `MutationObserver` work, unbounded allocations, and repeated material/geometry construction. Cache Three.js resources by chart/profile when practical, dispose GPU resources on teardown, honor `bundle.renderScale`, and preserve the canvas drift/reframe behavior already ported into `drum_highway_3d` and `keys_highway_3d`.

Validate all user-controlled data. Local storage, pad/pedal profiles, and settings should be read through guarded helpers, parsed defensively, clamped to sensible ranges, and stripped of prototype-pollution keys. MIDI mappings are post-MVP, but should follow the same rule if added. Use a plugin-specific localStorage prefix such as `multipad_h3d_`.

Use self-contained assets and styles. If the settings UI or screen uses Tailwind classes that core may not ship, build a preflight-off plugin stylesheet under `assets/` and declare it via `styles`. Do not rely on runtime Tailwind, remote CSS, or CDN-only assets. Use the vendored Three.js copy under `/static/vendor/three/` wherever possible.

Plan for both v2 and v3 UI behavior. The renderer itself should work unchanged in both UIs. If future controls are injected into the player chrome, use the v3 plugin-control slot when available and keep v2 behavior intact. Settings should remain usable from Settings -> Plugins.

Keep contribution and release hygiene in view. The main FeedBack repo asks plugin contributors to use AGPL-compatible licensing for curated plugins, keep diagnostics redaction-safe, document hardware assumptions, and add tests that protect the renderer contract, capability declarations, routing, and performance-sensitive behavior.

Plan for standalone release from the beginning. During development this plugin lives under `feedBack/plugins/multipad_highway_3d` for convenience, but V1 should ship from its own repository following the existing `got-feedBack/feedBack-plugin-*` pattern used by repos such as `feedBack-plugin-editor`, `feedBack-plugin-drums`, and `feedBack-plugin-keys-highway-3d`. The intended release repository name is `got-feedBack/feedBack-plugin-multipad-highway-3d`, matching the existing `feedBack-plugin-keys-highway-3d` naming pattern, so keep code, docs, assets, tests, licensing, and version metadata portable enough to break out cleanly instead of depending on private paths or unrelated main-repo state. The plugin should not be installed by default in normal FeedBack builds; when a user installs it, Auto mode can reasonably prefer the multipad visual for drum charts because that install is the user's explicit choice.

## 2. Components Needed for `multipad_highway_3d`

`plugin.json` manifest: Declares `id: "multipad_highway_3d"`, user-facing name, version, visualization type, bundled status if promoted, script/settings/assets, category, description, icon, standards, and capability metadata. MVP capability metadata should only claim `visualization` provider behavior. Add `midi-input` or `note-detection` only in later work if this plugin takes ownership of input/scoring behavior instead of simply visualizing the same drum data used by `drum_highway_3d`.

Renderer factory and lifecycle: A `screen.js` factory registered as `window.feedBackViz_multipad_highway_3d`. It owns Three.js scene setup, canvas sizing, chart rendering, settings application, teardown, and test hooks. It should mirror the host contract used by `highway_3d`, `drum_highway_3d`, and `keys_highway_3d`, and should reuse existing 3D highway/tunnel behavior wherever practical.

Pad profile model: A pad-layout model mapped from the same drum piece vocabulary and kit-routing assumptions used by `drum_highway_3d`. The MVP default is a generic 3x3 layout, but the model should remain suitable for other m x n multipad shapes. Built-in on-unit pads live in `pads`; external pad triggers do not belong in the pad profile because they are off-grid inputs with their own UI. This should not introduce a new MIDI or chart schema in the MVP. The profile's job is to decide how existing drum pieces appear on the built-in pad grid. Like `drum_highway_3d` kits, pad profiles should remain configurable later: users should be able to choose which pieces are directly represented and which compatible pieces fall back to those surfaces.

Pedal profile model: A separate profile for pedals, shaped like the pad profile with a `pedals` list. The MVP default should map `hh_pedal` to `surface: "outline-top"` and `kick` to `surface: "outline-bottom"`; both are pedal surfaces on the active pad grid rather than pads. Secondary footswitches and controller-specific pedal inputs can remain future extensions.

External trigger profile model: A separate profile for optional external pad triggers, shaped like the pedal profile with a `triggers` list. The MVP default should be `generic-triggers` with an empty trigger list. Hardware-specific or user-configured profiles can map pieces such as `snare` to off-grid trigger surfaces like `surface: "outline-left"` or `surface: "external-left-center"` without changing the built-in pad grid. Dual-zone external triggers can route their center/head hit to an `external-*-center` surface and their rim/edge hit to the matching `external-*-edge` surface.

Pad geometry and coordinate map: Converts a pad profile into 3D render surfaces, labels, hit regions, lighting zones, and camera framing. The highway/tunnel depth should match the existing 3D highways; unlike `drum_highway_3d`, only the front hit plane should read as a pad-controller grid instead of a linear row of lanes. The MVP pedal visualization should use top and bottom grid-outline surfaces. External trigger surfaces may use side outlines or single-pad-sized circular pads placed outside the pad grid so they do not overlap pads or outline strips. External pad center surfaces should use quieter fill colors; edge surfaces should use visibly thick, saturated rings in the same side color because center/head and edge/rim are zones of one physical trigger and are not normally independent simultaneous targets.

Chart-to-pad routing layer: Converts `bundle.drumTab.hits` into scheduled hit events by reusing the same canonical drum piece ids, labels, default kit routing, fallbacks, and MIDI assumptions already present in `drum_highway_3d`. It should not invent new ids such as mockup pad names. For the MVP, pad pieces that `drum_highway_3d` already understands are displayed on the active pad grid unless an external trigger profile explicitly routes a piece to an off-grid trigger surface, while `hh_pedal` and `kick` are displayed through the pedal profile as pedal-surface events. Keep the routing logic as close to `drum_highway_3d` as possible: direct profile assignments win, profile fallbacks cover missing compatible pieces, and hits with no direct or fallback route fail soft rather than inventing a new surface.

Hit source vs render surface model: Projected hit events should keep source/category fields separate from rendering fields. `event.type` remains the semantic source category (`pad`, `pedal`, or `trigger`) and the event keeps the matching source id (`padId`, `pedalId`, or `triggerId`) for future scoring. Rendering uses `event.surfaceId`, which points to a visual surface such as `pad:8`, `outline-top`, `outline-left`, or `external-left-edge`. Renderer internals should use surface vocabulary (`surfaces`, `surfaceForEvent`, `buildSurfaceGrid`) rather than overloaded legacy names.

MIDI input/session layer, post-MVP only: If this plugin later needs its own input path, use the core `midi-input` capability as a requester and mirror `drum_highway_3d` behavior. The MVP should not add new MIDI session handling.

MIDI-to-pad mapping layer, post-MVP only: Prefer the same MIDI-to-piece mapping used by `drum_highway_3d` if/when input is added. Do not create a new pad-note schema for the MVP. Input should resolve MIDI note -> drum piece -> active pad/pedal route, using the same profile fallback rules as chart projection.

Hit detection and scoring layer, post-MVP only: If this plugin later scores input, match `drum_highway_3d` behavior and timing windows. Scoring should compare the routed source/surface identity, not the raw MIDI note or original piece id: pad hits match by `padId`, external trigger hits match by `triggerId`, pedal hits match by `pedalId` or `surfaceId`, and both chart hits and MIDI input should pass through the same piece-to-route projection first. The MVP should focus on UI/visualization and not claim or implement note detection.

Hit event and FX layer: Renders approaching notes, note threshold flashes, timing colors when supplied, sparks, kick shake, hit group cues for same-time hits, and optional audio-reactive ambience. Until MIDI/scoring is implemented, chart playback should not flash or pulse target surfaces in a way that implies a confirmed hit. This layer should borrow stable shared helpers from `drum_highway_3d` and `highway_3d` whenever the behavior matches; do not clone-and-fork helper code unless the multipad hit plane actually needs different behavior.

Optional drum synth/audio feedback layer: Provides local audible pad feedback, probably by reusing the WebAudioFont drum-kit approach from the drum plugins. It must be optional and volume-controlled because the song audio remains the primary playback path.

Settings UI: A `settings.html` panel for pad profile selection, pedal profile selection, external trigger profile selection, direct piece-to-surface assignment, per-surface colors, camera/graphics options, and hit feedback intensity. Pad assignments should be shown as a grid matching the selected pad layout, not as a linear drum-lane list. The settings panel should show a read-only unmapped-piece summary for chart pieces that are not directly assigned to any pad, pedal, or trigger; fallback routing remains renderer-owned behavior, not a separate settings editor. MIDI device selection, learn mode, synth volume, and scoring controls should wait until input/scoring moves into scope.

Test and diagnostics hooks: A small `__test` export for pure data helpers and a `window.__multipadH3dTest` hook for browser tests to inject synthetic hit events, inspect projection state, and probe effects without physical hardware.

Documentation and assets: A README, thumbnail asset, screenshots after implementation, license file if this becomes standalone, and concise notes explaining how multipad profiles differ from the existing linear drum highway.

Routes, only if needed: The MVP should not need server routes. Add `routes.py` only if later work introduces uploaded profiles, shared profile libraries, or server-side preset generation.

## 3. Component Dependencies

`plugin.json` depends on the chosen file layout and capability decisions. For MVP it should claim only visualization behavior; it should not claim `midi-input` or `note-detection`.

Renderer factory depends on the host visualization contract, vendored Three.js, the pad geometry map, chart routing, settings readers, and lifecycle-safe MIDI focus handling.

Pad profile model depends on the drum piece vocabulary and default kit behavior already used by `drum_highway_3d`, plus local settings persistence. It is a layout layer, not a controller-specific MIDI schema; the MVP profile happens to be generic 3x3.

Pedal profile model depends on the same drum piece vocabulary and the active settings. The MVP default is a generic pedal profile that renders `hh_pedal` with `surface: "outline-top"` and `kick` with `surface: "outline-bottom"`.

Pad geometry and coordinate map depends on the active pad profile and settings. The renderer, chart routing, hit feedback, and settings preview all depend on this coordinate map.

Chart-to-pad routing depends on `bundle.drumTab`, `drum_highway_3d`-compatible piece routing, the active pad profile, the active pedal profile, the active external trigger profile, and the hit variant parser. In the MVP it feeds rendering only. The multipad default may expose more pieces directly than the 7-lane drum highway because it starts with a 3x3 grid plus two pedal surfaces, but the fallback semantics should remain the same.

MIDI input/session is post-MVP. If added later, it depends on the core `midi-input` domain and should mirror `drum_highway_3d`.

MIDI-to-pad mapping is post-MVP. If added later, it depends on the same MIDI-to-piece defaults used by `drum_highway_3d`, not a new multipad-only note schema. MIDI input should be normalized to canonical drum pieces before applying the active pad/pedal profile.

Hit detection and scoring is post-MVP. If added later, it depends on chart-to-pad routing, current chart time from the renderer bundle, MIDI-to-piece mapping, and the focused renderer instance. Matching should use the same routed source/surface identity that rendering uses, equivalent to `drum_highway_3d` comparing routed lane to routed lane. Stats/progression and note-detection events depend on scoring once they are added.

Hit event and FX layer depends on renderer lifecycle, pad geometry, chart-to-pad routing, chart-derived state, settings, and Three.js resource caches.

Optional synth/audio feedback is post-MVP. If added later, it depends on MIDI events, volume settings, browser AudioContext availability, and a loaded drum sample/preset set. It should not block rendering if audio initialization fails.

Settings UI depends on window APIs exposed by `screen.js`, safe localStorage-backed settings, and profile helpers. MIDI device-list events are post-MVP.

Test hooks depend on pure helper boundaries and renderer instance state. They should not require real MIDI devices, real WebAudio output, or private server state.

Recommended build order is: manifest plan, pad/pedal profile helpers, chart-to-pad routing, renderer skeleton, 3D pad geometry, settings UI, FX polish, then optional MIDI/scoring work.

## 4. Testing Plan

Manifest and loader tests: Add a manifest contract test once `plugin.json` exists. Verify capability metadata passes `docs/plugin-manifest.schema.json`, declares only implemented domains, exposes category/description/icon metadata, and remains loadable when optional domains are absent.

Pure data tests: VM-load `screen.js` without DOM, localStorage, WebGL, MIDI, or audio. Test pad profile validation, pedal profile validation, external trigger profile validation, accepted surface tokens vs render-surface descriptors, `drum_highway_3d`-compatible piece routing, hit normalization, hit variant precedence, hit group grouping, and malformed input handling.

Drum vocabulary integration tests: Reuse expectations from `tests/test_drums_lib.py`: known pieces route somewhere, unknown future pieces fail soft, open/closed hi-hat remain distinct, velocities are clamped/ignored safely, and hits are sorted by time.

MIDI-domain tests, post-MVP: Mock the `midi-input` domain only if the plugin later adds its own input path. For MVP, verify the plugin does not require MIDI to render a drum chart.

Scoring tests, post-MVP: Use synthetic hits only if the plugin later adds scoring. When scoring exists, test that a MIDI input and chart hit with different original pieces but the same routed pad/pedal source or render surface can match, mirroring `drum_highway_3d` lane-based scoring. For MVP, test hit states derived from chart time, not live player input.

Renderer contract tests: Check factory registration, `contextType`, narrow `matchesArrangement`, idempotent `init`/`destroy`, split-panel focus behavior, resource disposal patterns, and the canvas resize/reframe drift logic already protected for drum/keys highways.

Browser and visual tests: Add Playwright coverage that loads a drum-tab song, selects Multipad Highway 3D, asserts the WebGL canvas is nonblank, verifies MVP pad-surface framing, verifies `hh_pedal` routes through the top outline surface, verifies `kick` routes through the bottom outline surface, verifies threshold crossing flashes the note gem rather than the target surface, and captures desktop/mobile/splitscreen screenshots.

Routing tests: Confirm Auto mode claims drum/percussion arrangements with drum tabs when this standalone plugin is installed, including when `drum_highway_3d` is also present, and does not claim Lead, Rhythm, Bass, Combo, Guitar, or notation-backed keys arrangements. Full-band packs should stay with the active instrument unless the active arrangement is drums/percussion.

Performance tests: Exercise dense drum charts and long sessions. Watch frame time, memory growth, GPU resource churn, and repeated renderer swaps. The draw loop should not query DOM or rebuild stable materials every frame.

Manual hardware tests, post-MVP: Once MIDI enters scope, test representative multipad controllers and a kick pedal path over USB MIDI, and if practical through 5-pin MIDI via an interface. For MVP, manually verify the generic 3x3 visual layout against drum charts without requiring hardware.

Regression commands to start with once code exists: `node --test plugins/multipad_highway_3d/tests/*.test.js`, relevant `tests/js/*highway*` tests, `pytest tests/test_plugin_manifest_contract.py tests/test_drums_lib.py tests/test_highway_ws_instrument_routing.py`, and focused Playwright specs for visualization loading.

## 5. Development Plan

Phase 1: Finalize the product shape. Lock the MVP profile model, generic 3x3 pad layout, separate generic pedal profile, pedal surface behavior, tracking/packaging expectations, and the MVP capability surface while keeping the plugin concept open to later m x n layouts.

Phase 1 output (locked):

- MVP visual shape: an abstract 3x3 performance grid with a front-facing hit plane and per-pad tunnels extending backward. The renderer should preserve the rectangular pad read at the play surface; perspective belongs behind the pads, not as distortion of the surface grid. The receding highway/tunnel portion should match `drum_highway_3d` and `highway_3d`; only the pad surface grid and pedal surface behavior are new.
- Default pad profile: generic 3x3 pad. It is not Alesis-specific and should work for any controller that can be treated as nine pads.
- Default pedal profile: generic pedals. Pedals are separate from the pad profile so pedal behavior can be changed later without redefining the pad grid.
- Default external trigger profile: generic empty trigger profile. External pad triggers are separate from the pad profile because they are off-grid inputs with their own surface UI.
- Pedal behavior: `hh_pedal` hits use `surface: "outline-top"`, and `kick` hits use `surface: "outline-bottom"`. They do not consume pads and do not use separate off-grid lanes in the MVP.
- Same-time events: simultaneous drum hits are called `hit groups`. A hit group may light multiple pads plus one or more pedal surfaces in the same scoring window.
- Default routing behavior: the generic 3x3 + two-pedal default may route more canonical pieces directly than `drum_highway_3d`'s 7-lane default, but it should use the same fallback philosophy. Direct assignments win; missing compatible pieces may fall back using the same kit assumptions; unknown or unsupported pieces are skipped without changing the chart vocabulary.
- Tracking/packaging: unignore the full `plugins/multipad_highway_3d` directory so the planning doc, mockup asset, and future implementation files can be checked in normally during in-tree development. Treat this directory as staging for the eventual standalone `got-feedBack/feedBack-plugin-multipad-highway-3d` repository, not as the final V1 release location.
- First shippable MVP capabilities: claim only `visualization` as a provider. Do not claim `midi-input` or `note-detection` for the MVP. Do not add routes for the MVP.
- Schema decision: no new profile schema is necessary for the MVP. The MIDI notes, drum pieces, kit configuration, labels, variants, and fallbacks should match the concepts already used by `drum_highway_3d`; this plugin's first job is to display the same drum data differently.

MVP visual projection rules:

- Use the existing drum piece vocabulary as the source of truth: `kick`, `snare`, `snare_xstick`, `hh_closed`, `hh_open`, `hh_pedal`, `tom_hi`, `tom_mid`, `tom_low`, `tom_floor`, `stack`, `crash_l`, `crash_r`, `splash`, `china`, `ride`, `ride_bell`, and `bell`.
- Use existing `drum_highway_3d` display labels where labels are needed. Do not make mockup labels such as TL/TC/TR canonical ids or persisted schema values.
- Use the existing `drum_highway_3d` default kit/fallback behavior as the initial chart-routing behavior. The visual layer may arrange routed pad pieces onto the active pad grid, but should not redefine what the pieces or MIDI notes mean. Even when the MVP profile maps more pieces directly, custom profiles should be able to fall back in the same way as drum kits when they expose fewer surfaces.
- MVP-specific render surfaces are the pad highway/hit plane plus pedal and external-trigger surfaces. The pads display existing pad pieces, the top outline surface displays `hh_pedal`, the bottom outline surface displays `kick`, side outline surfaces can display external triggers, and the left/right external pad center/edge surfaces provide non-overlapping dual-zone external-trigger options; neither the pads nor the surfaces are new drum piece ids.
- If a future profile format becomes necessary, it should be a thin visual-layout override on top of `drum_highway_3d` piece ids and labels, not a parallel MIDI/pad schema.
- Reuse-first rule: before implementing a helper in this plugin, check whether `drum_highway_3d`, `highway_3d`, `keys_highway_3d`, or core highway/capability code already owns that behavior. Prefer shared behavior and small adaptation layers over duplicate implementations.

Phase 2: Add the plugin skeleton. Create `plugin.json`, `screen.js`, `settings.html`, `assets/thumb.svg`, README, and license metadata. Register the visualization factory, return a no-op renderer cleanly, and make the settings page load without errors.

Phase 3: Build pure projection helpers. Implement pad profile validation for the MVP generic 3x3 layout, generic pedal profile validation with `surface: "outline-top"` / `surface: "outline-bottom"`, generic empty external trigger profile validation with surface-based custom trigger support, `drum_highway_3d`-compatible chart-to-pad projection, hit variant classification, hit group grouping, and localStorage-safe settings. Add the VM tests before connecting WebGL.

Phase 4: Render the multipad highway MVP. Build the 3D pad grid, camera framing, front hit plane/pad surfaces, pedal/trigger surfaces, hit event placement, and pooled note meshes. Then wire it to real `bundle.drumTab` data, enable `matchesArrangement` only once the renderer is visible/useful, and confirm Auto mode stays narrow by instrument: `multipad_highway_3d` may auto-claim drum/percussion arrangements whenever it is installed, including when `drum_highway_3d` is also installed, but must not claim Lead, Rhythm, Bass, Combo, Guitar, or keys arrangements.

Phase 5: Add settings and profile controls. Build pad profile selection starting with the MVP generic 3x3 layout, generic pedal profile selection, external trigger profile selection, configurable direct piece assignments, optional per-surface colors, camera/graphics controls, and feedback intensity settings.

Phase 5 first-draft requirements:

- The generic 3x3 layout remains the default, but the settings/profile controls must expose four default pad-layout choices: `3x3`, `2x4`, `4x3`, and `Custom`.
- The custom pad layout should use a click-and-drag grid UI so a user can create arbitrary active-cell patterns within the supported grid bounds.
- Pedal selection is separate from pad layout. Users should be able to enable up to two pedals.
- External trigger selection is separate from pad layout. Users should be able to enable up to two external pad triggers, and each trigger can be single-zone or two-zone.
- Default piece and color mappings must match `drum_highway_3d`. Color/piece remapping should use the same basic settings interaction model as `drum_highway_3d`, adapted from linear lanes to a grid of pads. Pads may hold multiple chart pieces, shown as removable chips in the pad cell.
- Unassigned pads, pedals, and trigger zones are valid. They must appear grayed out in settings and in the 3D highway. They must not send, receive, or route notes to their corresponding visual surfaces.
- Multiple pedals mapped to the same piece are valid. For example, two pedals may both map to `kick`; either pedal can send kick events later, but the 3D UI still shows the standard kick pedal surface rather than two distinct kick surfaces.
- If no pedal is mapped to `hh_pedal`, the special hi-hat pedal surface should not display as an active hi-hat surface.
- Selecting or saving a profile makes that profile the new default instead of generic 3x3. The persisted profile contract must include required metadata fields `version`, `id`, and `name`, plus pad layout, pad piece assignments, pad display surface colors, pedal count/selection, pedal piece assignments, pedal display surface colors, external trigger count/selection, trigger zone mode, external trigger piece assignments, external trigger display surface colors, and sanitized explicit fallback overrides for compatibility.

Phase 5 output:

- Settings now expose 3x3, 2x4, 4x3, and Custom pad layouts. Custom supports click-and-drag active-cell editing within the supported grid bounds.
- Saved multipad profiles replace the default profile and include required `version`, `id`, and `name` metadata, pad layout, pad assignments/colors, pedal selection and assignments/colors, external trigger slots/zones, trigger assignments/colors, and sanitized explicit fallback overrides for compatibility.
- Pad assignment settings are rendered as a grid matching the selected layout, with row/column wording reserved for accessibility labels.
- The always-visible "Unmapped chart pieces" summary reports direct assignment coverage across pads, pedals, and triggers. Renderer fallback routing remains centralized in `buildPieceToPadMap()`.
- Unassigned pads, pedals, and trigger zones are valid inactive controls. They render gray in settings and the 3D surface model and are excluded from routing.
- Duplicate pedal piece mappings are valid, including two pedals mapped to kick.
- Default piece colors use the same default palette mapping as `drum_highway_3d`.
- Renderer settings now apply label visibility, camera angle, scene theme, glow strength, hit feedback intensity, and hit group window.

Phase 6: Polish visual feedback. Add note threshold flashes, timing colors derived from chart state where available, sparks, ghost/accent/flam/open/bell cues, hit group cues, and shared background/cinematic helpers where they make sense. Target-surface hit flashes and scoring-style pulses should wait for real hit detection.

Phase 6 implementation note:

- For this plugin's MVP, articulations/cues are intentionally ignored. Ghost,
  accent, flam, open, and bell flags route as ordinary hits on the resolved
  pad, pedal, or trigger surface.
- Note threshold flashes, timing colors, sparks, and cinematic/background
  helpers should match `drum_highway_3d` behavior where a comparable multipad
  surface exists. Without MIDI/scoring ownership, timing defaults to the same
  on-time green used by `drum_highway_3d` for OK/unknown timing; EARLY/LATE
  timing fields are accepted when supplied by chart/test data.

Phase 6 output:

- Pad, pedal, and trigger hits render as plain hits on their resolved surface;
  articulation/cue variants are intentionally ignored for this MVP.
- Note threshold flashes, timing colors, sparks, kick shake, cinematic lighting,
  and background ambience now provide playback feedback without implying hit
  confirmation.
- Surface state reset restores base intensity, opacity, scale, and emissive
  color before each frame.
- Grid rebuild disposes old surface geometry/materials before creating fresh
  target and label meshes.

Phase 7: Stabilize the visual MVP. Run focused tests, verify desktop/mobile/splitscreen framing, tune performance, update docs/screenshots, and make sure the plugin works without MIDI hardware.

Phase 7 output:

- Real feedpak projection no longer caches only by `drumTab` object identity.
  The host streams real drum hits by appending `drum_hits` chunks into the same
  `bundle.drumTab.hits` array, so the renderer now invalidates projection when
  the hit count changes. This prevents the 3D lanes from being based on an early
  partial hit set.
- A present-but-empty `bundle.drumTab.hits` array is now treated as a real drum
  chart, matching `drum_highway_3d`. This prevents the multipad renderer from
  showing the demo pattern while real feedpak drum-hit chunks are still loading.
- The multipad renderer no longer carries a hardcoded demo note stream. With no
  real `bundle.drumTab`, it renders the pad grid without invented notes.
- Projection diagnostics now report source type, raw/normalized/projected hit
  counts, unknown pieces, unrouted pieces, and active profile ids through the
  renderer probe and a one-time console warning when chart data projects to zero
  notes.
- Multipad's canonical vocabulary now matches the current drum library's
  additional `stack` and `bell` pieces. Built-in profiles route `stack` with the
  crash family and `bell` with the ride family, and custom fallback routing can
  resolve those pieces explicitly.
- Focused JS tests now assert exact default piece-to-surface routing for every
  known pad piece, projection coverage for `stack` and `bell`, and real-chart
  detection for empty drum-tab hit streams.
- `screen.js` remains one delivered script for plugin-loader compatibility —
  `plugin.json`'s `"script"` field still points at it and the host still loads
  it as a single `<script>` tag — but it is now a **generated file**. It is
  authored as five files under `src/` (`01-constants.js`, `02-profiles.js`,
  `03-projection.js`, `04-renderer.js`, `05-api.js`), matching the same
  sections the file was already internally organized into (runtime constants
  and drum vocabulary, profile/settings validation, chart source selection and
  projection, Three.js renderer lifecycle, and public/test API registration).
  Run `./build.sh` after editing anything under `src/` and commit the
  regenerated `screen.js` in the same commit; CI's `multipad-h3d-js-fresh` job
  rebuilds and diffs it, mirroring the repo root's `tailwind-fresh` check. A
  lazy-`import()` split (mirroring how this plugin already lazy-loads
  Three.js) was evaluated and rejected: `__probe()` and the renderer
  lifecycle's no-canvas test path depend on state (`activeSettings`,
  `surfaces`, cached projection) that is read by always-synchronous code and
  written by Three.js-only code, so splitting across that boundary at import
  time would make `__probe()`/lifecycle behavior depend on network timing
  instead of staying synchronous. A source-level split with a generated
  runtime artifact keeps the plugin-loader contract, the test harness (which
  still `vm.runInContext`s the one generated `screen.js`), and this
  synchronous behavior completely unchanged. The renderer consumes a named
  `chartSourceFromBundle()` helper so `bundle.drumTab` source decisions are
  testable without WebGL.
- Visual framing uses a simple baseline with a small camera pan: the camera
  faces the target grid head-on, each lane extends straight backward from its
  target surface, and the camera/look target are shifted up-right so the target
  area sits slightly down-left on screen. The far highway origin is shifted very
  far up-right and compressed toward a shared back point so gems approach diagonally
  from the upper-right side of the view without moving the camera or target grid.
- Incoming note gems and rectangular target surfaces now share rounded-corner
  rectangle geometry, while circular trigger targets remain circular.
- Regular pad target surfaces now render as thin routed-color outlines with a
  10% opacity center fill, keeping the target grid visible without large solid
  color blocks.
- Note gem glow outlines are currently removed; they were not reading cleanly
  enough for the MVP and can be revisited later.
- Note gem bodies now use a subtle per-color gradient that darkens toward the
  lower-left corner. The visible gem face is a dedicated rounded front mesh with
  explicit UVs, keeping the gradient independent of extruded-body UV behavior.
- Transparent target fills no longer write depth, preventing target areas from
  cutting black holes through incoming gems while they are still behind the grid.
- The top and bottom pedal outline targets now share identical dimensions, and
  the floor plane sits below the full target grid so it does not cut through the
  bottom outline target.
- The old target-zone flash meshes and large kick floor flash have been removed;
  chart playback no longer creates visual feedback that implies a confirmed hit.
- Playback threshold crossing no longer flashes or pulses target areas; until
  real hit detection exists, crossing the threshold no longer flashes the
  note gem white either (see below) — chart playback creates no visual
  feedback that implies a confirmed hit or a miss judgement at all.
- After crossing the threshold, the gem no longer freezes in place — with no
  hit detection yet implemented, every note is effectively unhandled, so it
  keeps moving through the target at the same speed rather than disappearing
  abruptly. Position keeps extrapolating along the exact same back-point-to-
  target line it was already traveling on (`positionProgress` is not clamped
  above 1), instead of freezing laterally and only pushing forward in z —
  the latter used to create a visible kink in the travel direction right at
  the threshold. Size still caps at the target's own dimensions once past
  threshold (a separately clamped `scaleProgress`), so it doesn't keep
  growing in scale — any apparent growth past that point is perspective only.
  The gem also immediately (no fade-in) snaps to gray
  (`NOTE_PAST_THRESHOLD_COLOR`) at a flat 5% opacity (`NOTE_PAST_THRESHOLD_OPACITY`)
  — more transparent than the colored repeat-note gems (0.24 body / 0.2 face)
  — for the whole `NOTE_BEHIND_SEC` (0.18s) window it continues moving before
  being culled, rather than fading down from a brighter starting opacity.
  This snap-immediately behavior went through two more-gradual iterations
  first (a 0.8s fade, then a 0.3s fade matched to a threshold-crossing white
  flash) before landing here: both left the gem reading as noticeably bright
  — and, combined with continuing to grow via perspective, noticeably large
  — for a perceptible stretch right after crossing. The threshold-crossing
  white flash mentioned in earlier phases has been removed entirely: it was
  normal- (not additive-) blended toward white, so even shortened to 100ms it
  was still the dominant contributor to that lingering-bright appearance,
  directly working against gems being dim immediately.
- Incoming gems are drawn at their real target dimensions (`surface.w/h`) at
  every progress value - there is no separate world-space size-growth curve.
  Camera perspective alone (the same distance-based foreshortening that
  makes anything look smaller far away) accounts for gems reading as smaller
  near spawn; nothing artificially shrinks them on top of that. This is the
  end state of three earlier attempts at a world-space size-growth curve,
  each fixing one artifact and surfacing the next:
  1. A flat eased curve (cubic, 43%/68%-of-target starting scale depending on
     event type) - grew independently of gem *position*, which shrinks
     toward its neighbors via `TUNNEL_BACK_SCALE`-based back-projection.
     Those two curves diverged badly at low progress (0.43-0.68 vs. 0.12),
     so distant gems visibly overlapped each other and spilled outside a
     correctly-sized-but-comparatively-tiny layout-preview outline.
  2. A shared `tunnelScaleFactor(progress)` helper (linear, `TUNNEL_BACK_SCALE`
     → 1) used by *both* gem size and the outline - fixed same-instant
     overlap within one hit group, but surfaced a different artifact: a
     dense, evenly-timed stream of hits on the *same* pad would visibly
     overtake and overlap itself partway down the highway, then the gap
     would balloon back open near the target ("gems start out fast, then
     slow down and bunch up, then speed up again"). Root cause, confirmed by
     simulating the real camera-projection math: on-screen gem *spacing*
     from the next hit on the same pad only goes through one camera-distance
     division, but on-screen gem *size* goes through that division *on top
     of* its own already-growing world-space curve, so size briefly grew
     faster than spacing before both re-converged at the target.
  3. Cubic-easing the progress fed into `tunnelScaleFactor` for size only
     (`sizeProgress = scaleProgress ** 3`) removed that mid-flight overtake
     without touching position or the outline - but the compounded result
     (two nested curves plus camera perspective) started reading as visually
     extreme/goofy, particularly right near the threshold.
  Removing the size curve entirely (this state) sidesteps all three
  artifacts at once - there's only one thing determining "how big," so
  nothing can grow out of step with anything else - at the cost of losing
  the deliberate "grows into place" cue those curves provided; see the
  spawn fade-in below for its replacement.
- With no size ramp to signal "just spawned," gems instead fade in from
  fully transparent over `NOTE_SPAWN_FADE_SEC` (0.25s) - `fadeInFactor` in
  `placeNote`, a 0..1 ramp over elapsed time since the note entered the
  lookahead window, multiplied into whatever opacity the note would
  otherwise have (repeat, past-threshold, or normal). The layout-preview
  outline (below) fades in the same way, via the same `fadeInFactor` passed
  through from `placeNote`.
- Removing the size-shrink curve (above) surfaced one more mismatch:
  individual pad *positions* were still interpolating toward their own
  per-pad back-projected point at `TUNNEL_BACK_SCALE` (12%) of their real
  offset from grid center - the same mechanism gem size used to share before
  it was removed - while the layout-preview outline had already moved to a
  fixed real (unscaled) size with only its *center* converging toward the
  vanishing point. So a just-spawned gem sat near the *center* of an
  already-correctly-shaped, already-full-size outline box instead of at its
  real proportional spot within it, only migrating out to the right place as
  it approached the target - reported directly from a screenshot of a
  just-faded-in gem sitting near the middle of its outline instead of at the
  top-center position it should have read at from the start. `placeNote` now
  builds gem position the same way `placeLayoutPreview` builds the outline's
  position: the *grid's own center* converges toward the back/vanishing
  point (`centerX = TUNNEL_BACK_X_OFFSET * (1 - positionProgress)`, `centerY
  = GRID_CENTER_Y + TUNNEL_BACK_LIFT * (1 - positionProgress)` - literally
  the same two lines placeLayoutPreview already used), and each pad's own
  offset from that center (`surface.x`, `surface.y - GRID_CENTER_Y`) is
  added on top *unscaled* - real, constant, never compressed toward the
  vanishing point on its own. A gem is now at the exact right relative spot
  inside the outline at every progress value, not just once it arrives, and
  - as a side effect - this also removes the last size/position growth-rate
  mismatch that could still compound with camera perspective: with gem size
  now constant (real target size) and gem offset-from-center now constant
  too, apparent (on-screen) size and apparent (on-screen) spacing both grow
  via the exact same single camera-distance division, so their ratio no
  longer drifts across progress the way it could when either one carried
  its own separate progress-dependent curve.
- **Consolidation refactor.** Three bugs in a row (this section's history)
  were the same shape: the "where does a point in the grid's local space
  appear at a given travel progress" transform got reimplemented separately
  in `placeNote` and `placeLayoutPreview`, and the two copies drifted out of
  sync - different size curves, then a size/position growth-rate mismatch,
  then a position-only compression the outline didn't share. Rather than
  keep hand-syncing two formulas, that transform is now one module-scoped
  pure function, `projectGridPoint(localOffsetX, localOffsetY, progress)`,
  returning `{x, y}`. Both callers pass their own local offset from the
  grid's center - a pad's `(surface.x, surface.y - GRID_CENTER_Y)`, or
  `(0, 0)` for the outline's own center - and get the identical
  center-convergence math back. Exposed via `__test.projectGridPoint` for
  unit testing (`tests/skeleton.test.js`): one test locks in the formula's
  exact values at the endpoints and confirms offsets stay unscaled at every
  sampled progress; a second sweeps every pad in the default 3x3 profile
  against the outline's own projected half-extents at several progress
  values, so a future edit that reintroduces a second, diverging formula at
  either call site (instead of updating `projectGridPoint` itself) fails a
  fast unit test instead of only turning up in a screenshot days later.
- Hit-feedback sparks spawn from multiple points spread evenly around a
  target surface's whole border (`sparkBorderBurst`), rather than clustering
  at one spot near the top — applies to rectangular pads/pedal bars and
  circular external triggers alike.
- Approaching non-repeat, pre-threshold pad notes (`placeLayoutPreview`) carry
  a faint white outline of the whole pad grid's bounding box with them as they
  travel, so the hit group reads as one unit rather than a loose cluster of
  gems. The outline's center is derived from the same back-projection math
  as an individual pad's own x/y (the grid box's local center is always
  `(0, GRID_CENTER_Y)`, so back-projecting that one point collapses to
  `centerX = TUNNEL_BACK_X_OFFSET * (1 - scaleProgress)`, `centerY =
  GRID_CENTER_Y + TUNNEL_BACK_LIFT * (1 - scaleProgress)`); it moves in step
  with the note gems, but - like gem size (see above) - is drawn at its real
  full (`gridW`/`gridH`) size throughout rather than scaled up from a
  smaller spawn size, plus a small fixed margin (`LAYOUT_PREVIEW_GROUP_MARGIN`,
  0.14 world units added to each side in `buildLayoutPreviewGroupFrameGeometry`)
  so the frame reads as a border around the hit group instead of touching
  the outermost gems. The margin only inflates the rendered frame geometry -
  `gridW`/`gridH` themselves (used for pad positions, the tunnel guide lines,
  and the outline-bounds test) are untouched, so gems stay comfortably
  inside the margin rather than right up against it. The outline is a filled thin-frame shape (`buildFrameGeometry` — an
  outer rounded rect with a smaller rounded rect hole cut out), not a stroked
  `Line`: WebGL clamps `LineBasicMaterial.linewidth` to 1px on most
  platforms, so a genuinely visible border needs real geometry.
  `buildFrameGeometry` takes an explicit corner radius rather than deriving
  one from its own outer `w`/`h` (its only previous behavior) - a margin
  wide enough on the *straight* edges still let a corner gem touch or
  overlap the outline, because the default radius
  (`Math.min(w, h) * NOTE_GEM_CORNER_RADIUS`, using the outline's own full
  outer dimensions) came out several times larger than any individual gem's
  own rounding: for a full 3x3 grid that's roughly a 0.53-unit radius vs.
  a single gem's ~0.14, and a large rounded corner cuts inward (relative to
  the sharp bounding-box corner) by more than the straight-edge margin
  alone accounted for. The outline now uses
  `LAYOUT_PREVIEW_GROUP_CORNER_RADIUS` - fixed at individual-gem scale
  (`NOTE_GEM_CORNER_RADIUS * Math.min(PAD_W, PAD_H)`), independent of the
  whole grid's size - so the rounding at a corner is consistent with a
  gem's own corner and doesn't eat into the margin. Per-pad
  outlines (one per cell, each pad's own target color) were tried first but
  removed — once the single whole-group outline existed, the individual cell
  outlines added visual noise without adding information. Only pad-type hits
  draw this (pedal/trigger hits aren't part of the pad grid's own coordinate
  space). Repeat and past-threshold notes don't draw this overlay — repeat
  notes because it would be redundant with the
  still-visible earlier note in the group, past-threshold notes because
  they're already fading out.
- The outline mesh shares note gems' own `renderOrder` (10, matching
  body/face) rather than a fixed lower value. Three.js only sorts transparent
  objects by camera distance *within* the same `renderOrder` — across
  different `renderOrder`s it draws strictly in `renderOrder` sequence
  regardless of depth. A fixed lower `renderOrder` on the outline meant every
  outline (any hit group, any distance) drew before every gem, so a nearer
  hit group's outline could get painted over by a farther, still-approaching
  hit group's gem (drawn later in submission order, but actually farther
  away) instead of correctly occluding it. Sharing `renderOrder` lets
  Three.js's normal per-frame distance sort handle outlines and gems
  together, so nearer objects correctly occlude farther ones regardless of
  which hit group they belong to.
- Per-pad tunnel guide lines (the frustum from each pad toward the vanishing
  point) are drawn once for the whole grid's bounding box, not once per pad
  cell — one line-per-pad cluttered the highway with a full guide frustum for
  every single cell. The shared guide-line material sets `depthWrite: false`
  and a low `renderOrder` (1, well under note gems' 10/11) so it always draws
  behind incoming notes instead of z-fighting/poking through them.
- A hit event counts as a repeat of the immediately previous group when its
  own surface was also present in that previous group - per surface, not per
  whole-group composition (`groupHitEvents` in `03-projection.js`). A steady
  repeating hi-hat stays marked repeat even the moment another piece (e.g. a
  snare) joins it or drops back out alongside it: `1. hihat(new) 2.
  hihat(repeat) 3. hihat(repeat)+snare(new) 4. hihat(repeat) 5. snare(new) 6.
  hihat(new)` - steps 3-4 show a joining/leaving second piece not
  interrupting the hi-hat's own streak, while step 6 shows the check is
  against the *immediately previous* group specifically (snare-only at step
  5), not "the last group this piece itself appeared in" (which would've
  been step 4). Repeat members render as the same gem shape at reduced
  body/face opacity (0.24 body / 0.2 face - bumped up from an earlier, more
  transparent 0.14/0.1 pass that read as too faint) instead of the normal
  filled gem — pad-type events only; `placeNote`'s `isRepeat` is gated on
  `event.type === 'pad'`, so pedal/trigger gems always render at full
  opacity regardless of their own `repeatedFromPreviousGroup` value. The
  faded-repeat cue is a pad-grid-pattern-recognition aid; it didn't add much
  for the single top/bottom pedal bars or side/external trigger surfaces,
  which don't form a recognizable multi-cell pattern the way pads do. (A
  whole-group-set-equality version of this check — where any
  membership change, including an unrelated pedal joining/leaving, reset
  every member in the group to "not repeat" — was tried in between and
  rejected as over-eager for exactly the joining/leaving-second-piece case
  above.)
- The layout-preview outline (`placeLayoutPreview`, only ever drawn for
  pad-type events) reuses this same per-surface `repeatedFromPreviousGroup`
  flag directly — there's no separate pad-only variant of it. Pad surface ids
  (`pad:<id>`) are never shared with pedal/trigger surface ids, so for a
  pad-type event, "was my surface in the previous group's full surface set"
  and "...in the previous group's pad-only subset" are provably the same
  question with the same answer under a per-surface check — unlike under the
  rejected whole-set-equality version, where a pedal joining/leaving *did*
  change the whole-group answer even though it never touched the pad's own
  membership. (An earlier `padSetRepeatedFromPreviousGroup` field existed
  specifically to give the outline pedal-blindness the whole-set check
  didn't have; it became redundant with the switch to per-surface checking
  and was removed.)
- The layout-preview outline fades linearly from `LAYOUT_PREVIEW_GROUP_OPACITY`
  (0.45, its peak, while still far away) down to fully 0 by the time it
  reaches the target (`opacity = LAYOUT_PREVIEW_GROUP_OPACITY * (1 -
  scaleProgress)` in `placeLayoutPreview`), rather than staying at a flat
  opacity all the way to the threshold.
- Kick screen shake is reduced to roughly half the previous magnitude and
  duration so feedback reads as an accent instead of dominating the view.
- `NOTE_SPEED` raised from 7.25 to 11.0 as an experiment against high-hit-
  density charts where notes were visually running together. This is a
  purely spatial knob — it controls how many world units of depth correspond
  to one second of chart-time gap between notes, spreading close-together
  hits further apart in 3D space so they read as visually distinct instead of
  overlapping. It does not by itself change how much real reaction time a
  note is visible for.
- Reaction-time lookahead is no longer a flat seconds value — it's expressed
  in beats (`NOTE_AHEAD_BEATS = 2.24`, chosen as "about 2 and a quarter beats" without
  risking an edge-case hit group right at the 2-and-a-quarter-beat boundary reading as
  still-resolving) and converted to seconds from the chart's own local tempo
  each frame (`updateNoteAheadFromTempo`, using the two `bundle.beats`
  entries bracketing the current playhead — so it follows tempo changes
  through the song rather than assuming one fixed BPM). Falls back to a flat
  `NOTE_AHEAD_FALLBACK_SEC` (2.0s, matching the previous flat value) when the
  chart has no usable beat grid (fewer than 2 beats — e.g. no
  `song_timeline`).
- Because `NOTE_AHEAD_BEATS`'s seconds equivalent now varies with tempo, a
  note's growth-curve progress (`placeNote`'s `rawProgress`) is normalized
  against a per-frame `activeNoteSpawnDepth` (`activeNoteAheadSec *
  NOTE_SPEED`) instead of the fixed `TUNNEL_DEPTH` — otherwise a note would
  pop in partway grown (spawn depth < `TUNNEL_DEPTH`) or sit static in the
  distance before animating (spawn depth > `TUNNEL_DEPTH`) whenever the
  current tempo didn't happen to match the one `TUNNEL_DEPTH` was tuned for.
  `TUNNEL_DEPTH` itself stays fixed — it's now purely cosmetic, sizing only
  the guide-line wireframe and the camera's look-at target, decoupled from
  where notes actually spawn.
- **Code-smell pass** over all five `src/*.js` files. Fixed, in order of
  impact:
  - Dead code: the pooled note mesh's `flash` (a third mesh/material per
    note, left over from the removed threshold-crossing white flash) was
    still being created, positioned, and reset every frame despite never
    being made visible or given nonzero opacity anywhere. Removed
    entirely, along with the now-unused `NOTE_GEM_FLASH_Z_OFFSET` constant.
  - Material leak: template note materials (`noteMaterials`) and the
    layout-preview outline's template material are only ever `.clone()`d
    onto scene meshes, so they never enter the scene graph and
    `disposeObjectTree(scene)` never reaches them. `teardown()` was
    dropping both via plain reassignment (`noteMaterials = new Map()`,
    `layoutPreviewGroupMaterial = null`) with no `.dispose()` call, leaking
    them (and their canvas gradient textures) on every teardown/init
    cycle. Fixed via a new shared `disposeNoteMaterials()` (built on the
    existing `disposeMaterial` helper, which also disposes a material's
    `.map` texture - something the old glow-strength-change code path,
    which disposed materials directly, was itself missing) used from both
    `teardown()` and the settings-change path, plus an explicit dispose
    for `layoutPreviewGroupMaterial` in `teardown()`.
  - Duplication: `lowerBoundHitEvents` (`.t`-keyed) and `lowerBoundTimeField`
    (`.time`-keyed) were the identical binary search with a different
    hardcoded field name. Consolidated onto a shared
    `lowerBoundByField(entries, minTime, field)`; both original names are
    kept as thin wrappers since `lowerBoundHitEvents` is asserted on by
    name in tests and `lowerBoundTimeField` is called throughout
    `04-renderer.js`.
  - Duplication: `validatePadProfile`, `validatePedalProfile`, and
    `validateTriggerProfile` each independently re-implemented "is this a
    valid `#rrggbb` string, else format a fallback hex" (including redoing
    the same regex `colorHexFromCss` already encapsulates) and "default
    label from the first assigned piece." Extracted `sanitizeProfileColor`
    and `defaultLabelForPieces` (`01-constants.js`, next to the existing
    `sanitizeProfileId`/`sanitizeProfileDisplayText`) and pointed all three
    validators at them - each keeps its own fallback *color value* (their
    semantics genuinely differ: pad falls back through the piece palette
    to a neutral surface color, pedal always has a default piece to fall
    back to, trigger falls back to a distinct purple), only the
    valid-hex-or-fallback mechanics are now shared. Also replaced a
    hand-typed `'#2d3748'` magic string (pad's no-piece color fallback)
    with `SCENE_COLORS.inactiveSurface` formatted through the same helper.
  - Duplication: `readSettings()` read `showLabels` with its own two-line
    `'1'/'true'` vs. `'0'/'false'` block right above a loop doing the
    identical thing for `timingColors`/`hitSparks`/`cinematicLighting`.
    Folded `showLabels` into that loop.
  - Duplication: `projectDrumTab`'s three hit-event branches (pedal,
    trigger, pad) each ended with the same `hitEvents.push(...)` /
    `stats.projectedHits++` / `incrementCount(stats.projectedPieces, ...)`
    triplet. Extracted a local `recordEvent(event)` closure; each branch
    now just builds its event shape (which still differs meaningfully
    between the three - different id/label/surface fields) and calls it.
  - Stale comment: `NOTE_AHEAD_BEATS`'s comment cited its old value (2.24,
    "rather than 2.25") and a specific "2-and-a-quarter beats" framing that
    no longer matched the constant after a later manual tuning pass changed
    it to 1.99 - reworded to describe the *why* (avoid double-showing a
    hit group that lands exactly on a round-fraction boundary) without
    hardcoding to a specific fraction that goes stale on the next retune.
  All 25 tests (23 prior + the 2 `projectGridPoint` tests from the
  consolidation refactor above) pass unchanged, and the renderer was
  re-verified visually - including exercising a settings change and a
  teardown/reinit cycle (viz picker away and back) to specifically drive
  the new material-disposal path - with no console errors and no visual
  regressions.
- **Test-suite review.** Went through `tests/skeleton.test.js` for
  stale/useless assertions and simplification opportunities:
  - Fixed one non-diagnostic assertion: the pad-profile-validation test
    injected `"__proto__":"snare"` via `JSON.parse` to probe
    prototype-pollution safety, then asserted `{}.polluted === undefined`
    - checking a property name (`polluted`) that was never part of the
      injected payload, on an unrelated object literal. It would pass
      regardless of whether the code had a real pollution bug. Replaced
      with assertions on the actual defenses: `profile.fallbacks` has a
      genuinely null prototype (matches `validatePadProfile`'s
      `Object.create(null)`), and `'__proto__'` never became an own member.
  - Found a real coverage gap: the only renderer-lifecycle test always
    calls `renderer.init(null, ...)`, which returns before ever calling
    `loadThree()` - so `initScene()`, `buildSurfaceGrid()`, `placeNote()`,
    `placeLayoutPreview()`, and all per-frame render code were **never
    exercised by any test**, only by manual Playwright checks. This is
    exactly the gap the `NOTE_SPAWN_FADE_SEC is not defined` crash earlier
    in this session fell through - a real init+draw test would have caught
    it in milliseconds instead of requiring a full docker+browser
    investigation to even notice something was wrong.
  - Closed the gap: added `tests/three-stub.js`, a minimal fake of the
    slice of the Three.js API `04-renderer.js` actually calls (`Scene`,
    `Group`, `Mesh`, materials, geometries, camera, lights, `WebGLRenderer`,
    etc. - structurally correct, no real geometric math, no WebGL). Wired
    it into `loadFactoryHarness()` via the `window.__multipadH3dThree`
    escape hatch `loadThree()`'s own doc comment already anticipated but
    the harness never actually used. Added two tests that drive a real
    `init(fakeCanvas(), bundle)` → `draw(bundleWithDrumTab)` →
    `destroy()` cycle (plus a destroy/re-init cycle, matching the real
    `playSong()` stop()→init() contract) and assert it doesn't throw and
    produces the expected surface/note counts. Verified the new tests
    actually catch this class of bug by temporarily reintroducing the
    exact `NOTE_SPAWN_FADE_SEC` crash and confirming both new tests failed
    with the right error, then reverting.
- **`settings.html` cleanup** (HTML validity + code smells in its embedded
  script). Verified the static markup's tag balance and every `for=`/`id=`
  pairing programmatically (no genuine W3C-relevant errors - the local
  `tidy` binary is HTML4-era and flags valid HTML5 like `role`/`aria-*`/
  `type=range`/`type=number` as "proprietary," so it wasn't a useful
  validator here beyond confirming tag nesting). Findings:
  - Dead code: a `clone(value)` JSON-round-trip helper was defined but
    never called anywhere in the file. Removed.
  - Magic-string duplication: the "unassigned" fallback color `'#2d3748'`
    (matches core's `SCENE_COLORS.inactiveSurface`) was hand-typed **13
    times** across pad/pedal/trigger color-resolution logic. Extracted a
    `UNASSIGNED_COLOR` constant and a `firstPieceColor(pieces)` helper for
    the repeated "first assigned piece's color, else unassigned" ternary,
    and pointed all 13 call sites at them.
  - Duplicated defaults: `hydrateDisplayControls()` had a ~10-field
    hardcoded fallback object mirroring `DEFAULT_SETTINGS` from
    `01-constants.js`, only reachable if `window.multipadH3dGetSettings`
    were missing - but `boot()` (the function's only caller) already gates
    on `window.multipadH3dGetProfile`, and `installSettingsGlobals()`
    installs every `multipadH3d*` global in one synchronous pass, so the
    fallback was dead in practice and would only have silently gone stale
    if core's own defaults ever changed. Removed; the function now trusts
    `window.multipadH3dGetSettings()` directly, matching the trust boundary
    `boot()` already established for the sibling globals.
  - Accessibility inconsistency: `renderPads()` carefully adds
    `aria-label` to every dynamically-created `<select>`/`<input
    type=color>`, but `renderPedals()`, `renderTriggers()`, and `zoneRow()`
    built their analogous controls via template-string `innerHTML` with no
    accessible name at all (only an adjacent, unassociated `<span>`).
    Added matching `aria-label`s so a screen reader announces "Pedal 1
    piece" / "Trigger 1 Edge color" etc. instead of a bare, unnamed
    control.
  - Inconsistent operation order: nearly every mutate-then-persist handler
    calls `saveProfile(); render();`, but two call sites
    (`applyCustomDimensions()`, the custom-grid cell `onclick`) called them
    in the opposite order. Harmless either way (both operate off the
    already-mutated in-memory `profile`, `render()` doesn't depend on
    `saveProfile()` having run), but normalized to the dominant order for
    readability.
  Verified via Playwright against the real Settings → Graphics →
  "Multipad Highway 3D" panel: initial render (pad grid colors, pedal/
  trigger dropdowns, all graphics sliders/checkboxes) matches pre-change
  behavior; confirmed the new `aria-label`s resolve correctly via
  `getAttribute`; exercised pedal count 0→2, trigger count 0→2, switching
  a trigger to 2-zone, assigning a piece to the new edge zone (color
  swatch resolved correctly through the new `firstPieceColor` path), and
  removing one piece from a multi-piece pad (color correctly stayed, since
  only pads left with *zero* pieces reset to `UNASSIGNED_COLOR`) - no
  console errors beyond pre-existing unrelated 404s.

Phase 8, post-MVP: Add MIDI/scoring only if needed. If this plugin takes ownership of input or scoring later, connect to the core `midi-input` domain, mirror `drum_highway_3d` MIDI-to-piece behavior, implement hit/miss matching by routed pad/pedal source or render surface rather than raw MIDI note or original piece id, then consider `note-detection`, stats, progression, synth feedback, and scoring diagnostics.

Phase 9, post-MVP: Production hardening. Test with real hardware only after MIDI enters scope, profile performance, fix rehydration/splitscreen edge cases, broaden docs, and prepare the plugin for review.

## 6. Additional Work to Get Production Ready

Visual preset quality: The MVP generic 3x3 pad profile, generic pedal profile, and empty generic external trigger profile should be verified against representative drum charts. Hardware-specific presets can wait until MIDI/input enters scope.

Fallback behavior: Define what users see on browsers without WebGL2, without drum tabs, or with unsupported chart data. The plugin should degrade visually without requiring MIDI hardware.

Accessibility and usability: Settings must be keyboard usable, labels should be clear, and controls should fit narrow panels. The 3D view should keep labels readable without relying only on color.

Security and privacy: Imported profiles, localStorage settings, and diagnostics should be sanitized. If MIDI device support is added later, public diagnostics should not leak local device identifiers beyond the pseudonymized patterns used elsewhere.

Performance hardening: Profile dense charts, long songs, repeated song swaps, and splitscreen. Confirm WebGL resources are disposed, sample loading is bounded, and background effects can be disabled on weaker devices.

Documentation: Add README usage notes, a visual-layout section, screenshots, known limitations, and a short comparison with `drum_highway_3d`. Hardware setup and Web MIDI troubleshooting belong with the post-MVP MIDI/scoring work.

Release hygiene: Choose an AGPL-compatible license, maintain a changelog, bump versions when settings/styles/assets change, and include the plugin in any curated-list metadata only after tests and docs are complete. V1 release packaging should happen from the standalone `feedBack-plugin-multipad-highway-3d` repository; keep the in-tree `plugins/multipad_highway_3d` history and standalone release history easy to separate if the plugin is later mirrored back into the main FeedBack repo.

QA matrix: Before production, test v2 UI, v3 UI, desktop browser, desktop app if applicable, splitscreen, selected-instrument routing, full-band sloppaks, drum-only sloppaks, missing drum tabs, and dense drum charts. Add real multipad testing once MIDI/input enters scope.

## 7. Areas for Future Further Development

Additional controller profiles: Add presets for Roland SPD-SX/SPD-SX Pro, Yamaha DTX-Multi, Alesis SamplePad, Akai MPD-style pads, Launchpad-style grids, and user-shared custom profiles.

MIDI output and pad lighting: Explore whether supported controllers can receive MIDI feedback for pad LEDs, metronome pulses, hit/miss colors, or upcoming-note previews.

External triggers and pedals: External pad triggers live in a dedicated trigger profile with surface-based UI, separate from the built-in pad profile. Later work should add hardware-specific trigger presets and promote footswitches, dual-zone triggers, choke gestures, aftertouch, and control-change gestures into first-class profile inputs.

Multiplayer and splitscreen expansion: Eventually support both `drum_highway_3d` and `multipad_highway_3d` at the same time so one player can use a drumset while another uses a multipad. That requires app-level visualization routing, per-panel instrument ownership, and likely MIDI/session ownership changes outside this plugin. Until those host changes exist, this standalone plugin can override the standard drum highway for drum charts when installed. Continue to support drummer-plus-guitar practice sessions without fighting over input focus.

Visual themes and stage integration: Add hardware-inspired skins, alternate camera modes, stage/venue lighting sync, audience-facing performance mode, and lower-cost 2D/Canvas fallback visuals.

multipad highway release plan

0.1.0: Completed MVP
	-No hit detection, only visuals (works for disconnected playalong)
	-No major visual bugs
	-Default 3x3 grid w/two pedals tested
	-Other grids & custom: not tested
	-Settings: happy cases tested for 3x3

0.2.0: Placeholder release, may not use, but keeping in case I have a good idea 
	-maybe this is where we test other grid/kit layouts
	-maybe support circle & larger/smaller pads
	-save/load/share multiple total kit profiles (pads + pedals + triggers), auto load last used
	-anything else that comes to mind that can doesn't involve MIDI support yet

0.3.0: MIDI/hit detection
	-maybe it'll just work?? use same logic as drum highway
	-hit/miss effects
	-scoring including combo tracker (may put off to 0.4.0)
	-input device timing calibration NOT included here

0.4.0: Placeholder release, may not use
  -maybe include device calibration here
	-better handling fills (fill detected -> hit pads however you want)
	-more settings improvements
	-bug fixes

1.0rc1: see if can clean up the visuals more and improve settings usability
	-all pad/pedal/trigger combos tested
	-better note gem display & visual effects
	-performance improvements
  -ensure the 3x3, 2x4, and 4x3 default layouts specifically match corresponding roland, nux, and yamaha pad defaults
  -cool backgrounds
  -fix last round of bugs