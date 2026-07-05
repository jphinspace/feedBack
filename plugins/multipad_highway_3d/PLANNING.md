# Multipad Highway 3D Plugin Plan

![3x3 matrix note highway wireframe](assets/multipad_3x3_highway_wireframe.png)

Design reference: the MVP visual direction is a front-facing 3x3 pad matrix
where each pad extrudes backward into its own tunnel. The longer-term
visual model should support m x n multipad layouts. Notes should remain inside
their target pad, including simultaneous hits, rather than becoming a
single horizontal row of separate lanes.

Highway/tunnel reference: the receding 3D highway, tunnel depth, note travel,
camera feel, lighting language, and general motion style should match the
existing `drum_highway_3d` and guitar/bass `highway_3d` plugins as much as
possible. The new visual work is the front target area: a multipad hit plane
plus pedal indicator behavior.

Mockup interpretation: treat the image as an abstract MVP performance grid, not
a literal Alesis Strike MultiPad physical layout or a permanent 3x3-only
constraint. The default MVP pad profile should be a generic 3x3 pad layout;
future profiles may use other m x n multipad shapes. `kick` and `hh_pedal`
hits should be handled by a separate default pedal profile, then represented
as bottom and top indicators around the active multipad grid.
The play surface is a front-facing hit plane made of rectangular pads,
while the depth behind it provides the highway/tunnel perspective.
Same-time labels in the mockup should become "hit group" in production docs and
UI, meaning multiple drum hits scheduled at the same time. Positional labels in
the mockup are noncanonical placeholders; real labels should come from the same
drum piece labels/routing already used by `drum_highway_3d`.

## 1. Best Practices for Developing Plugins for This Repository

Use the bundled plugins as the primary shape guide before writing new code. For this plugin, the closest local references are `plugins/drum_highway_3d`, `plugins/highway_3d`, and `plugins/keys_highway_3d`; useful upstream references include `got-feedBack/feedBack`, `got-feedBack/feedBack-plugin-drums`, `got-feedBack/feedBack-plugin-keys-highway-3d`, and `got-feedBack/feedBack-plugin-editor`.

Avoid reinventing the wheel. If `drum_highway_3d`, `highway_3d`, `keys_highway_3d`, core highway code, or capability domains already solve a behavior, reuse or adapt that implementation instead of duplicating it. New code in this plugin should be limited to the multipad-specific target plane, pedal indicator presentation, and the minimal glue needed to render existing drum data through that presentation.

Keep the plugin contract boring and explicit. A visualization plugin should declare `type: "visualization"` in `plugin.json`, register `window.feedBackViz_multipad_highway_3d`, and return a renderer object with the host `setRenderer` lifecycle: `init(canvas, bundle)`, `draw(bundle)`, `resize(w, h)`, and `destroy()`. Add `contextType: "webgl2"` when the renderer needs WebGL2, and keep `matchesArrangement(songInfo)` narrow enough that Auto mode does not steal guitar, bass, or keys arrangements from their own visualizers.

Prefer capability domains over private browser APIs when the plugin eventually owns input or scoring behavior. MIDI should go through the core `midi-input` domain as a requester, mirroring `drum_highway_3d` and the upstream 2D drums plugin. If the plugin later emits scored hits/misses, declare and implement the relevant `note-detection` behavior rather than using an untracked window-global side channel. For the MVP, prioritize the UI/visualization path and avoid new MIDI or note-detection claims.

Treat the highway bundle as read-only. For drum charts, prefer `bundle.drumTab` over decoding guitar-style `bundle.notes`; `static/highway.js` streams drum tab metadata and chunked hits from the server, and `lib/drums.py` is the canonical vocabulary for piece ids, default GM MIDI notes, categories, shapes, colors, presets, and wire normalization.

Make renderer state instance-safe. Splitscreen and renderer rehydration mean a plugin can be initialized more than once. Keep per-renderer scene state inside the factory instance, use module-level singletons only for browser-unique resources such as MIDI access or shared audio samples, and make every async open/connect path generation-safe so a late result cannot reattach a destroyed renderer.

Keep the draw path disciplined. Avoid per-frame DOM queries, broad `MutationObserver` work, unbounded allocations, and repeated material/geometry construction. Cache Three.js resources by chart/profile when practical, dispose GPU resources on teardown, honor `bundle.renderScale`, and preserve the canvas drift/reframe behavior already ported into `drum_highway_3d` and `keys_highway_3d`.

Validate all user-controlled data. Local storage, pad/pedal profiles, and settings should be read through guarded helpers, parsed defensively, clamped to sensible ranges, and stripped of prototype-pollution keys. MIDI mappings are post-MVP, but should follow the same rule if added. Use a plugin-specific localStorage prefix such as `multipad_h3d_`.

Use self-contained assets and styles. If the settings UI or screen uses Tailwind classes that core may not ship, build a preflight-off plugin stylesheet under `assets/` and declare it via `styles`. Do not rely on runtime Tailwind, remote CSS, or CDN-only assets. Use the vendored Three.js copy under `/static/vendor/three/` wherever possible.

Plan for both v2 and v3 UI behavior. The renderer itself should work unchanged in both UIs. If future controls are injected into the player chrome, use the v3 plugin-control slot when available and keep v2 behavior intact. Settings should remain usable from Settings -> Plugins.

Keep contribution and release hygiene in view. The main FeedBack repo asks plugin contributors to use AGPL-compatible licensing for curated plugins, keep diagnostics redaction-safe, document hardware assumptions, and add tests that protect the renderer contract, capability declarations, routing, and performance-sensitive behavior.

## 2. Components Needed for `multipad_highway_3d`

`plugin.json` manifest: Declares `id: "multipad_highway_3d"`, user-facing name, version, visualization type, bundled status if promoted, script/settings/assets, category, description, icon, standards, and capability metadata. MVP capability metadata should only claim `visualization` provider behavior. Add `midi-input` or `note-detection` only in later work if this plugin takes ownership of input/scoring behavior instead of simply visualizing the same drum data used by `drum_highway_3d`.

Renderer factory and lifecycle: A `screen.js` factory registered as `window.feedBackViz_multipad_highway_3d`. It owns Three.js scene setup, canvas sizing, chart rendering, settings application, teardown, and test hooks. It should mirror the host contract used by `highway_3d`, `drum_highway_3d`, and `keys_highway_3d`, and should reuse existing 3D highway/tunnel behavior wherever practical.

Pad profile model: A pad-layout model mapped from the same drum piece vocabulary and kit-routing assumptions used by `drum_highway_3d`. The MVP default is a generic 3x3 layout, but the model should remain suitable for other m x n multipad shapes. This should not introduce a new MIDI or chart schema in the MVP. The profile's job is to decide how existing drum pieces appear on the pad grid. Like `drum_highway_3d` kits, pad profiles should remain configurable later: users should be able to choose which pieces are directly represented and which compatible pieces fall back to those surfaces.

Pedal profile model: A separate profile for pedals, shaped like the pad profile with a `pedals` list. The MVP default should map `hh_pedal` to `indicator: "outline-top"` and `kick` to `indicator: "outline-bottom"`; both are pedal indicators on the active pad grid rather than pads. Secondary footswitches and controller-specific pedal inputs can remain future extensions.

Pad geometry and coordinate map: Converts a pad profile into 3D landing zones, labels, hit regions, lighting zones, and camera framing. The highway/tunnel depth should match the existing 3D highways; unlike `drum_highway_3d`, only the front target area should read as a pad-controller grid instead of a linear row of lanes. The MVP pedal visualization should use top and bottom grid-outline indicators; later profiles may add other indicator styles only if they do not compromise the matrix-highway read.

Chart-to-pad routing layer: Converts `bundle.drumTab.hits` into scheduled hit events by reusing the same canonical drum piece ids, labels, default kit routing, fallbacks, and MIDI assumptions already present in `drum_highway_3d`. It should not invent new ids such as mockup pad names. For the MVP, pad pieces that `drum_highway_3d` already understands are displayed on the active pad grid, while `hh_pedal` and `kick` are displayed through the pedal profile as indicator events. Keep the routing logic as close to `drum_highway_3d` as possible: direct profile assignments win, profile fallbacks cover missing compatible pieces, and hits with no direct or fallback route fail soft rather than inventing a new target.

MIDI input/session layer, post-MVP only: If this plugin later needs its own input path, use `window.slopsmith.midiInput` through the core `midi-input` capability and mirror `drum_highway_3d` behavior. The MVP should not add new MIDI session handling.

MIDI-to-pad mapping layer, post-MVP only: Prefer the same MIDI-to-piece mapping used by `drum_highway_3d` if/when input is added. Do not create a new pad-note schema for the MVP. Input should resolve MIDI note -> drum piece -> active pad/pedal route, using the same profile fallback rules as chart projection.

Hit detection and scoring layer, post-MVP only: If this plugin later scores input, match `drum_highway_3d` behavior and timing windows. Scoring should compare the routed target, not the raw MIDI note or original piece id: pad hits match by `padId`, pedal hits match by pedal indicator/pedal target, and both chart hits and MIDI input should pass through the same piece-to-target routing first. The MVP should focus on UI/visualization and not claim or implement note detection.

Hit event and FX layer: Renders approaching notes, pad landing flashes, timing colors, sparks, combo feedback, ghost/accent/flam shapes, pedal indicator pulses, hit group cues for same-time hits, and optional audio-reactive ambience. This layer should borrow stable shared helpers from `drum_highway_3d` and `highway_3d` whenever the behavior matches; do not clone-and-fork helper code unless the multipad target plane actually needs different behavior.

Optional drum synth/audio feedback layer: Provides local audible pad feedback, probably by reusing the WebAudioFont drum-kit approach from the drum plugins. It must be optional and volume-controlled because the song audio remains the primary playback path.

Settings UI: A `settings.html` panel for pad profile selection, pedal profile selection, per-piece/per-pad display labels or colors if needed, camera/graphics options, and hit feedback intensity. MIDI device selection, learn mode, synth volume, and scoring controls should wait until input/scoring moves into scope.

Test and diagnostics hooks: A small `__test` export for pure data helpers and a `window.__multipadH3dTest` hook for browser tests to inject synthetic hit events, inspect projection state, and probe effects without physical hardware.

Documentation and assets: A README, thumbnail asset, screenshots after implementation, license file if this becomes standalone, and concise notes explaining how multipad profiles differ from the existing linear drum highway.

Routes, only if needed: The MVP should not need server routes. Add `routes.py` only if later work introduces uploaded profiles, shared profile libraries, or server-side preset generation.

## 3. Component Dependencies

`plugin.json` depends on the chosen file layout and capability decisions. For MVP it should claim only visualization behavior; it should not claim `midi-input` or `note-detection`.

Renderer factory depends on the host visualization contract, vendored Three.js, the pad geometry map, chart routing, settings readers, and lifecycle-safe MIDI focus handling.

Pad profile model depends on the drum piece vocabulary and default kit behavior already used by `drum_highway_3d`, plus local settings persistence. It is a layout layer, not a controller-specific MIDI schema; the MVP profile happens to be generic 3x3.

Pedal profile model depends on the same drum piece vocabulary and the active settings. The MVP default is a generic pedal profile that renders `hh_pedal` with `indicator: "outline-top"` and `kick` with `indicator: "outline-bottom"`.

Pad geometry and coordinate map depends on the active pad profile and settings. The renderer, chart routing, hit feedback, and settings preview all depend on this coordinate map.

Chart-to-pad routing depends on `bundle.drumTab`, `drum_highway_3d`-compatible piece routing, the active pad profile, the active pedal profile, and the hit variant parser. In the MVP it feeds rendering only. The multipad default may expose more pieces directly than the 7-lane drum highway because it starts with a 3x3 grid plus two pedal indicators, but the fallback semantics should remain the same.

MIDI input/session is post-MVP. If added later, it depends on the core `midi-input` domain and should mirror `drum_highway_3d`.

MIDI-to-pad mapping is post-MVP. If added later, it depends on the same MIDI-to-piece defaults used by `drum_highway_3d`, not a new multipad-only note schema. MIDI input should be normalized to canonical drum pieces before applying the active pad/pedal profile.

Hit detection and scoring is post-MVP. If added later, it depends on chart-to-pad routing, current chart time from the renderer bundle, MIDI-to-piece mapping, and the focused renderer instance. Matching should use the same routed target identity that rendering uses, equivalent to `drum_highway_3d` comparing routed lane to routed lane. Stats/progression and note-detection events depend on scoring once they are added.

Hit event and FX layer depends on renderer lifecycle, pad geometry, chart-to-pad routing, chart-derived state, settings, and Three.js resource caches.

Optional synth/audio feedback is post-MVP. If added later, it depends on MIDI events, volume settings, browser AudioContext availability, and a loaded drum sample/preset set. It should not block rendering if audio initialization fails.

Settings UI depends on window APIs exposed by `screen.js`, safe localStorage-backed settings, and profile helpers. MIDI device-list events are post-MVP.

Test hooks depend on pure helper boundaries and renderer instance state. They should not require real MIDI devices, real WebAudio output, or private server state.

Recommended build order is: manifest plan, pad/pedal profile helpers, chart-to-pad routing, renderer skeleton, 3D pad geometry, settings UI, FX polish, then optional MIDI/scoring work.

## 4. Testing Plan

Manifest and loader tests: Add a manifest contract test once `plugin.json` exists. Verify capability metadata passes `docs/plugin-manifest.schema.json`, declares only implemented domains, exposes category/description/icon metadata, and remains loadable when optional domains are absent.

Pure data tests: VM-load `screen.js` without DOM, localStorage, WebGL, MIDI, or audio. Test pad profile validation, pedal profile validation, `drum_highway_3d`-compatible piece routing, hit normalization, hit variant precedence, hit group grouping, and malformed input handling.

Drum vocabulary integration tests: Reuse expectations from `tests/test_drums_lib.py`: known pieces route somewhere, unknown future pieces fail soft, open/closed hi-hat remain distinct, velocities are clamped/ignored safely, and hits are sorted by time.

MIDI-domain tests, post-MVP: Mock the `midi-input` domain only if the plugin later adds its own input path. For MVP, verify the plugin does not require MIDI to render a drum chart.

Scoring tests, post-MVP: Use synthetic hits only if the plugin later adds scoring. When scoring exists, test that a MIDI input and chart hit with different original pieces but the same routed pad/pedal target can match, mirroring `drum_highway_3d` lane-based scoring. For MVP, test hit states derived from chart time, not live player input.

Renderer contract tests: Check factory registration, `contextType`, narrow `matchesArrangement`, idempotent `init`/`destroy`, split-panel focus behavior, resource disposal patterns, and the canvas resize/reframe drift logic already protected for drum/keys highways.

Browser and visual tests: Add Playwright coverage that loads a drum-tab song, selects Multipad Highway 3D, asserts the WebGL canvas is nonblank, verifies MVP target-pad framing, verifies `hh_pedal` pulses the top outline, verifies `kick` pulses the bottom outline, and captures desktop/mobile/splitscreen screenshots.

Routing tests: Confirm Auto mode only claims drum/percussion arrangements with drum tabs when `drum_highway_3d` is unavailable, and does not claim Lead, Rhythm, Bass, Combo, Guitar, or notation-backed keys arrangements. Full-band packs should stay with the active instrument unless the active arrangement is drums and the standard drum highway is absent.

Performance tests: Exercise dense drum charts and long sessions. Watch frame time, memory growth, GPU resource churn, and repeated renderer swaps. The draw loop should not query DOM or rebuild stable materials every frame.

Manual hardware tests, post-MVP: Once MIDI enters scope, test representative multipad controllers and a kick pedal path over USB MIDI, and if practical through 5-pin MIDI via an interface. For MVP, manually verify the generic 3x3 visual layout against drum charts without requiring hardware.

Regression commands to start with once code exists: `node --test plugins/multipad_highway_3d/tests/*.test.js`, relevant `tests/js/*highway*` tests, `pytest tests/test_plugin_manifest_contract.py tests/test_drums_lib.py tests/test_highway_ws_instrument_routing.py`, and targeted Playwright specs for visualization loading.

## 5. Development Plan

Phase 1: Finalize the product shape. Lock the MVP profile model, generic 3x3 pad layout, separate generic pedal profile, pedal indicator behavior, tracking/packaging expectations, and the MVP capability surface while keeping the plugin concept open to later m x n layouts.

Phase 1 output (locked):

- MVP visual shape: an abstract 3x3 performance grid with a front-facing hit plane and per-pad tunnels extending backward. The renderer should preserve the rectangular pad read at the play surface; perspective belongs behind the pads, not as distortion of the target grid. The receding highway/tunnel portion should match `drum_highway_3d` and `highway_3d`; only the target plane and pedal indicator behavior are new.
- Default pad profile: generic 3x3 pad. It is not Alesis-specific and should work for any controller that can be treated as nine pads.
- Default pedal profile: generic pedals. Pedals are separate from the pad profile so pedal behavior can be changed later without redefining the pad grid.
- Pedal behavior: `hh_pedal` hits use `indicator: "outline-top"`, and `kick` hits use `indicator: "outline-bottom"`. They do not consume pads and do not use separate off-grid lanes in the MVP.
- Same-time events: simultaneous drum hits are called `hit groups`. A hit group may light multiple pads plus one or more pedal indicators in the same scoring window.
- Default routing behavior: the generic 3x3 + two-pedal default may route more canonical pieces directly than `drum_highway_3d`'s 7-lane default, but it should use the same fallback philosophy. Direct assignments win; missing compatible pieces may fall back using the same kit assumptions; unknown or unsupported pieces are skipped without changing the chart vocabulary.
- Tracking/packaging: unignore the full `plugins/multipad_highway_3d` directory so the planning doc, mockup asset, and future implementation files can be checked in normally.
- First shippable MVP capabilities: claim only `visualization` as a provider. Do not claim `midi-input` or `note-detection` for the MVP. Do not add routes for the MVP.
- Schema decision: no new profile schema is necessary for the MVP. The MIDI notes, drum pieces, kit configuration, labels, variants, and fallbacks should match the concepts already used by `drum_highway_3d`; this plugin's first job is to display the same drum data differently.

MVP visual projection rules:

- Use the existing `drum_highway_3d` piece vocabulary as the source of truth: `kick`, `snare`, `snare_xstick`, `hh_closed`, `hh_open`, `hh_pedal`, `tom_hi`, `tom_mid`, `tom_low`, `tom_floor`, `crash_l`, `crash_r`, `splash`, `china`, `ride`, and `ride_bell`.
- Use existing `drum_highway_3d` display labels where labels are needed. Do not make mockup labels such as TL/TC/TR canonical ids or persisted schema values.
- Use the existing `drum_highway_3d` default kit/fallback behavior as the initial chart-routing behavior. The visual layer may arrange routed pad pieces onto the active pad grid, but should not redefine what the pieces or MIDI notes mean. Even when the MVP profile maps more pieces directly, custom profiles should be able to fall back in the same way as drum kits when they expose fewer surfaces.
- MVP-specific targets are the pad highway/target plane plus pedal indicators. The pads display existing pad pieces, the top outline indicator displays `hh_pedal`, and the bottom outline indicator displays `kick`; neither the pads nor the indicators are new drum piece ids.
- If a future profile format becomes necessary, it should be a thin visual-layout override on top of `drum_highway_3d` piece ids and labels, not a parallel MIDI/pad schema.
- Reuse-first rule: before implementing a helper in this plugin, check whether `drum_highway_3d`, `highway_3d`, `keys_highway_3d`, or core highway/capability code already owns that behavior. Prefer shared behavior and small adaptation layers over duplicate implementations.

Phase 2: Add the plugin skeleton. Create `plugin.json`, `screen.js`, `settings.html`, `assets/thumb.svg`, README, and license metadata. Register the visualization factory, return a no-op renderer cleanly, and make the settings page load without errors.

Phase 3: Build pure projection helpers. Implement pad profile validation for the MVP generic 3x3 layout, generic pedal profile validation with `indicator: "outline-top"` / `indicator: "outline-bottom"`, `drum_highway_3d`-compatible chart-to-pad projection, hit variant classification, hit group grouping, and localStorage-safe settings. Add the VM tests before connecting WebGL.

Phase 4: Render the multipad highway MVP. Build the 3D pad grid, camera framing, front hit plane/pad targets, hit event placement, basic note meshes, and demo fallback. Then wire it to real `bundle.drumTab` data, enable `matchesArrangement` only once the renderer is visible/useful, and confirm Auto mode stays narrow: `drum_highway_3d` remains the default for drum/percussion arrangements, while `multipad_highway_3d` only auto-claims those arrangements when the standard drum highway is unavailable.

Phase 5: Add settings and profile controls. Build pad profile selection starting with the MVP generic 3x3 layout, generic pedal profile selection, configurable direct piece assignments and fallbacks, optional per-piece display labels/colors, camera/graphics controls, and feedback intensity settings.

Phase 6: Polish visual feedback. Add pad flashes, timing colors derived from chart state where available, sparks, ghost/accent/flam/open/bell cues, pedal indicator pulses, hit group cues, and shared background/cinematic helpers where they make sense.

Phase 7: Stabilize the visual MVP. Run targeted tests, verify desktop/mobile/splitscreen framing, tune performance, update docs/screenshots, and make sure the plugin works without MIDI hardware.

Phase 8, post-MVP: Add MIDI/scoring only if needed. If this plugin takes ownership of input or scoring later, connect to the core `midi-input` domain, mirror `drum_highway_3d` MIDI-to-piece behavior, implement hit/miss matching by routed pad/pedal target rather than raw MIDI note or original piece id, then consider `note-detection`, stats, progression, synth feedback, and scoring diagnostics.

Phase 9, post-MVP: Production hardening. Test with real hardware only after MIDI enters scope, profile performance, fix rehydration/splitscreen edge cases, broaden docs, and prepare the plugin for review.

## 6. Additional Work to Get Production Ready

Visual preset quality: The MVP generic 3x3 pad profile and generic pedal profile should be verified against representative drum charts. Hardware-specific presets can wait until MIDI/input enters scope.

Fallback behavior: Define what users see on browsers without WebGL2, without drum tabs, or with unsupported chart data. The plugin should degrade visually without requiring MIDI hardware.

Accessibility and usability: Settings must be keyboard usable, labels should be clear, and controls should fit narrow panels. The 3D view should keep labels readable without relying only on color.

Security and privacy: Imported profiles, localStorage settings, and diagnostics should be sanitized. If MIDI device support is added later, public diagnostics should not leak local device identifiers beyond the pseudonymized patterns used elsewhere.

Performance hardening: Profile dense charts, long songs, repeated song swaps, and splitscreen. Confirm WebGL resources are disposed, sample loading is bounded, and background effects can be disabled on weaker devices.

Documentation: Add README usage notes, a visual-layout section, screenshots, known limitations, and a short comparison with `drum_highway_3d`. Hardware setup and Web MIDI troubleshooting belong with the post-MVP MIDI/scoring work.

Release hygiene: Choose an AGPL-compatible license, maintain a changelog, bump versions when settings/styles/assets change, keep bundled and standalone histories clear if promoted to core, and include the plugin in any curated-list metadata only after tests and docs are complete.

QA matrix: Before production, test v2 UI, v3 UI, desktop browser, desktop app if applicable, splitscreen, selected-instrument routing, full-band sloppaks, drum-only sloppaks, missing drum tabs, and dense drum charts. Add real multipad testing once MIDI/input enters scope.

## 7. Areas for Future Further Development

Additional controller profiles: Add presets for Roland SPD-SX/SPD-SX Pro, Yamaha DTX-Multi, Alesis SamplePad, Akai MPD-style pads, Launchpad-style grids, and user-shared custom profiles.

MIDI output and pad lighting: Explore whether supported controllers can receive MIDI feedback for pad LEDs, metronome pulses, hit/miss colors, or upcoming-note previews.

External triggers and pedals: Promote kick, hi-hat pedal, footswitches, dual-zone triggers, choke gestures, aftertouch, and control-change gestures into first-class profile inputs.

Advanced drum articulations: Add drags, ruffs, rolls, buzzes, cymbal chokes, stickings, left/right hand hints, double-kick notation, velocity-layer visuals, and per-piece timing windows.

Practice features: Add pad-specific drills, weak-pad review, adaptive difficulty, fills-only practice, groove loops, metronome subdivision overlays, and end-of-song feedback by pad.

Authoring workflow: Coordinate with editor/import tooling so drum-tab authors can target multipad profiles directly, preview pad layouts, and export recommended MIDI mappings with a song.

Multiplayer and splitscreen expansion: Support multiple MIDI controllers at once, per-panel device ownership, and drummer-plus-guitar practice sessions without fighting over input focus.

Visual themes and stage integration: Add hardware-inspired skins, alternate camera modes, stage/venue lighting sync, audience-facing performance mode, and lower-cost 2D/Canvas fallback visuals.

Profile sharing: Add safe layout preset sharing only if local profiles grow beyond the MVP generic pad grid and generic pedal defaults.
