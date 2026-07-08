// Multipad Highway 3D visualization plugin.
//
// GENERATED FILE — do not edit directly. Edit the numbered source file
// under src/ that matches the section you're touching, then run
// ./build.sh to regenerate this file. Source layout mirrors the plugin
// loader's single-script contract (plugin.json's "script" field still
// points at this one file):
//   src/01-constants.js    constants and drum vocabulary
//   src/02-profiles.js     profile/settings validation
//   src/03-projection.js   chart source and projection helpers
//   src/04-renderer.js     Three.js renderer lifecycle
//   src/05-api.js          test and settings-panel APIs
//   src/06-player-ui.js    player-controls toggle button

(function () {
    'use strict';

    // ---------------------------------------------------------------------
    // Runtime Constants
    // ---------------------------------------------------------------------

    /** Stable plugin id; must match plugin.json and the feedBackViz global name. */
    const PLUGIN_ID = 'multipad_highway_3d';
    const CONTEXT_TYPE = 'webgl2';
    const THREE_URL = '/static/vendor/three/three.module.min.js';
    const THREE_CDN = 'https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.min.js';
    let T = null;
    let threeLoadPromise = null;
    let settingsVersion = 0;

    /**
     * Load the vendored Three.js module once and cache it for all instances.
     *
     * Tests may provide `window.__multipadH3dThree` to avoid dynamic imports.
     *
     * @returns {Promise<object>} Promise resolving to the Three.js module.
     */
    function loadThree() {
        if (T) return Promise.resolve(T);
        if (window.__multipadH3dThree) {
            T = window.__multipadH3dThree;
            return Promise.resolve(T);
        }
        if (!threeLoadPromise) {
            threeLoadPromise = import(THREE_URL)
                .then(mod => { T = mod; return mod; })
                .catch(() => import(THREE_CDN)
                    .then(mod => { T = mod; return mod; })
                    .catch(err => {
                        console.error('[Multipad-Hwy3D] Three.js load failed:', err);
                        threeLoadPromise = null;
                        throw err;
                    }));
        }
        return threeLoadPromise;
    }
    /** Active renderer instances, used by tests and later split-screen hygiene. */
    const liveInstances = new Set();

    // ---------------------------------------------------------------------
    // Drum Vocabulary
    // ---------------------------------------------------------------------

    /**
     * Canonical drum piece ids mirrored from `lib/drums.py` and
     * `drum_highway_3d`. The multipad plugin projects these ids onto a pad
     * grid; it must not introduce new chart or MIDI piece names.
     */
    const ALL_PIECES = [
        'kick',
        'snare', 'snare_xstick',
        'hh_closed', 'hh_open', 'hh_pedal',
        'tom_hi', 'tom_mid', 'tom_low', 'tom_floor',
        'stack', 'crash_l', 'crash_r', 'splash', 'china',
        'ride', 'ride_bell', 'bell',
    ];
    /** Fast membership lookup for validating hits and profile pieces. */
    const PIECE_SET = new Set(ALL_PIECES);
    /** Pieces that render through pedal surfaces instead of occupying pads. */
    const PEDAL_PIECES = Object.freeze(['kick', 'hh_pedal']);
    const PEDAL_PIECE_SET = new Set(PEDAL_PIECES);
    /** Non-pedal pieces that may route to built-in pads or external trigger surfaces. */
    const PAD_PIECES = ALL_PIECES.filter(piece => !PEDAL_PIECE_SET.has(piece));
    /** MVP pedal surface tokens. Phase 4 maps these to grid-outline regions. */
    const PEDAL_SURFACES = Object.freeze(['outline-top', 'outline-bottom']);
    const PEDAL_SURFACE_SET = new Set(PEDAL_SURFACES);
    /** MVP external-trigger surface tokens for off-grid pad inputs. */
    const TRIGGER_SURFACES = Object.freeze([
        'outline-left', 'outline-right',
        'external-left-center', 'external-left-edge', 'external-left-rim',
        'external-right-center', 'external-right-edge', 'external-right-rim',
    ]);
    const TRIGGER_SURFACE_SET = new Set(TRIGGER_SURFACES);
    /** Short display labels kept compatible with the existing drum highway. */
    const PIECE_LABELS = {
        kick: 'KICK',
        snare: 'SNR',
        snare_xstick: 'XSTK',
        hh_closed: 'HHc',
        hh_open: 'HHo',
        hh_pedal: 'HHp',
        tom_hi: 'TM1',
        tom_mid: 'TM2',
        tom_low: 'TM3',
        tom_floor: 'FT',
        stack: 'STK',
        crash_l: 'CRl',
        crash_r: 'CRr',
        splash: 'SPL',
        china: 'CHN',
        ride: 'RD',
        ride_bell: 'BLL',
        bell: 'BEL',
    };
    /**
     * Full human-readable piece names - the single source of truth for
     * every "how does this piece read to a person" display in the plugin.
     * Renderer label sprites and the settings panel's piece dropdowns/chips
     * both read from this (settings.html fetches it via
     * multipadH3dGetPieceFriendlyLabels) instead of each keeping its own
     * copy, so the two can't drift out of sync. Distinct from PIECE_LABELS
     * above, which are short abbreviations (SNR, HHc, ...) kept for the
     * legacy drum_highway_3d-style short tags used elsewhere (event.label,
     * pedal pulse text) - on-highway target labels use this full form.
     */
    const PIECE_FRIENDLY_LABELS = Object.freeze({
        kick: 'Kick',
        snare: 'Snare',
        snare_xstick: 'Snare (cross-stick)',
        hh_closed: 'Hi-hat (closed)',
        hh_open: 'Hi-hat (open)',
        hh_pedal: 'Hi-hat (pedal)',
        tom_hi: 'Tom - high',
        tom_mid: 'Tom - mid',
        tom_low: 'Tom - low',
        tom_floor: 'Floor tom',
        stack: 'Stack',
        crash_l: 'Crash (left)',
        crash_r: 'Crash (right)',
        splash: 'Splash',
        china: 'China',
        ride: 'Ride',
        ride_bell: 'Ride bell',
        bell: 'Bell',
    });
    /**
     * Resolve a piece id to its full display name, falling back to the raw
     * id for a future/unknown piece (matches settings.html's own `friendly()`
     * fallback so the two never disagree on unknown input).
     *
     * @param {string} piece - Canonical drum piece id.
     * @returns {string}
     */
    function friendlyPieceLabel(piece) {
        return PIECE_FRIENDLY_LABELS[piece] || piece;
    }
    /**
     * MVP routing fallbacks for pieces that do not have their own built-in pad.
     * These adapt the drum highway's kit fallback idea to a pad grid without
     * changing the original chart piece id.
     */
    const PIECE_FALLBACKS = {
        snare_xstick: 'snare',
        hh_open: 'hh_closed',
        tom_low: 'tom_mid',
        stack: 'crash_l',
        crash_r: 'crash_l',
        splash: 'crash_l',
        china: 'crash_l',
        ride_bell: 'ride',
        bell: 'ride',
    };

    /**
     * Built-in MVP pad layout. It is intentionally named as a generic pad grid
     * even though the first profile is 3x3, so future 2x4, 4x3, or 1x12
     * profiles can use the same validation and projection helpers.
     */
    const DEFAULT_PAD_PROFILE = Object.freeze({
        version: 1,
        id: 'generic-3x3',
        name: 'Generic 3x3',
        rows: 3,
        cols: 3,
        pads: Object.freeze([
            Object.freeze({ id: '1', row: 0, col: 0, label: 'CRl', pieces: Object.freeze(['crash_l', 'splash', 'china', 'stack']) }),
            Object.freeze({ id: '2', row: 0, col: 1, label: 'HH', pieces: Object.freeze(['hh_closed', 'hh_open']) }),
            Object.freeze({ id: '3', row: 0, col: 2, label: 'CRr', pieces: Object.freeze(['crash_r']) }),
            Object.freeze({ id: '4', row: 1, col: 0, label: 'TM1', pieces: Object.freeze(['tom_hi']) }),
            Object.freeze({ id: '5', row: 1, col: 1, label: 'TM2', pieces: Object.freeze(['tom_mid', 'tom_low']) }),
            Object.freeze({ id: '6', row: 1, col: 2, label: 'RD', pieces: Object.freeze(['ride', 'ride_bell', 'bell']) }),
            Object.freeze({ id: '7', row: 2, col: 0, label: 'XSTK', pieces: Object.freeze(['snare_xstick']) }),
            Object.freeze({ id: '8', row: 2, col: 1, label: 'SNR', pieces: Object.freeze(['snare']) }),
            Object.freeze({ id: '9', row: 2, col: 2, label: 'FT', pieces: Object.freeze(['tom_floor']) }),
        ]),
        fallbacks: Object.freeze(Object.assign({}, PIECE_FALLBACKS)),
    });

    const BUILTIN_PAD_PROFILES = Object.freeze({
        'generic-3x3': DEFAULT_PAD_PROFILE,
        'generic-2x4': Object.freeze({
            version: 1,
            id: 'generic-2x4',
            name: 'Generic 2x4',
            rows: 2,
            cols: 4,
            pads: Object.freeze([
                Object.freeze({ id: '1', row: 0, col: 0, label: 'HH', pieces: Object.freeze(['hh_closed', 'hh_open']) }),
                Object.freeze({ id: '2', row: 0, col: 1, label: 'CRl', pieces: Object.freeze(['crash_l', 'splash', 'china', 'stack']) }),
                Object.freeze({ id: '3', row: 0, col: 2, label: 'RD', pieces: Object.freeze(['ride', 'ride_bell', 'bell']) }),
                Object.freeze({ id: '4', row: 0, col: 3, label: 'CRr', pieces: Object.freeze(['crash_r']) }),
                Object.freeze({ id: '5', row: 1, col: 0, label: 'SNR', pieces: Object.freeze(['snare', 'snare_xstick']) }),
                Object.freeze({ id: '6', row: 1, col: 1, label: 'TM1', pieces: Object.freeze(['tom_hi']) }),
                Object.freeze({ id: '7', row: 1, col: 2, label: 'TM2', pieces: Object.freeze(['tom_mid', 'tom_low']) }),
                Object.freeze({ id: '8', row: 1, col: 3, label: 'FT', pieces: Object.freeze(['tom_floor']) }),
            ]),
            fallbacks: Object.freeze(Object.assign({}, PIECE_FALLBACKS)),
        }),
        'generic-4x3': Object.freeze({
            version: 1,
            id: 'generic-4x3',
            name: 'Generic 4x3',
            rows: 4,
            cols: 3,
            pads: Object.freeze([
                Object.freeze({ id: '1', row: 0, col: 0, label: 'SPL', pieces: Object.freeze(['splash']) }),
                Object.freeze({ id: '2', row: 0, col: 1, label: 'CRl', pieces: Object.freeze(['crash_l']) }),
                Object.freeze({ id: '3', row: 0, col: 2, label: 'CRr', pieces: Object.freeze(['crash_r', 'china', 'stack']) }),
                Object.freeze({ id: '4', row: 1, col: 0, label: 'HH', pieces: Object.freeze(['hh_closed', 'hh_open']) }),
                Object.freeze({ id: '5', row: 1, col: 1, label: 'RD', pieces: Object.freeze(['ride']) }),
                Object.freeze({ id: '6', row: 1, col: 2, label: 'BLL', pieces: Object.freeze(['ride_bell', 'bell']) }),
                Object.freeze({ id: '7', row: 2, col: 0, label: 'TM1', pieces: Object.freeze(['tom_hi']) }),
                Object.freeze({ id: '8', row: 2, col: 1, label: 'TM2', pieces: Object.freeze(['tom_mid']) }),
                Object.freeze({ id: '9', row: 2, col: 2, label: 'TM3', pieces: Object.freeze(['tom_low']) }),
                Object.freeze({ id: '10', row: 3, col: 0, label: 'XSTK', pieces: Object.freeze(['snare_xstick']) }),
                Object.freeze({ id: '11', row: 3, col: 1, label: 'SNR', pieces: Object.freeze(['snare']) }),
                Object.freeze({ id: '12', row: 3, col: 2, label: 'FT', pieces: Object.freeze(['tom_floor']) }),
            ]),
            fallbacks: Object.freeze(Object.assign({}, PIECE_FALLBACKS)),
        }),
        custom: Object.freeze({
            version: 1,
            id: 'custom',
            name: 'Custom',
            rows: 3,
            cols: 3,
            pads: Object.freeze([
                Object.freeze({ id: '1', row: 0, col: 0, label: '', pieces: Object.freeze([]) }),
                Object.freeze({ id: '2', row: 0, col: 1, label: '', pieces: Object.freeze([]) }),
                Object.freeze({ id: '3', row: 0, col: 2, label: '', pieces: Object.freeze([]) }),
                Object.freeze({ id: '4', row: 1, col: 0, label: '', pieces: Object.freeze([]) }),
                Object.freeze({ id: '5', row: 1, col: 1, label: '', pieces: Object.freeze([]) }),
                Object.freeze({ id: '6', row: 1, col: 2, label: '', pieces: Object.freeze([]) }),
                Object.freeze({ id: '7', row: 2, col: 0, label: '', pieces: Object.freeze([]) }),
                Object.freeze({ id: '8', row: 2, col: 1, label: '', pieces: Object.freeze([]) }),
                Object.freeze({ id: '9', row: 2, col: 2, label: '', pieces: Object.freeze([]) }),
            ]),
            fallbacks: Object.freeze(Object.assign({}, PIECE_FALLBACKS)),
        }),
    });

    /**
     * Built-in pedal profile. Pedal pieces stay outside the pads and render on
     * outline surfaces around the active pad grid: hi-hat pedal on top, kick
     * on bottom.
     */
    const DEFAULT_PEDAL_PROFILE = Object.freeze({
        version: 1,
        id: 'generic-pedals',
        name: 'Generic pedals',
        pedals: Object.freeze([
            Object.freeze({
                id: 'hh-pedal',
                surface: 'outline-top',
                label: 'HHp',
                pieces: Object.freeze(['hh_pedal']),
                color: '#6bffe6',
            }),
            Object.freeze({
                id: 'kick',
                surface: 'outline-bottom',
                label: 'KICK',
                pieces: Object.freeze(['kick']),
                color: '#ffa030',
            }),
        ]),
    });

    /**
     * Built-in external trigger profile. External pad triggers are off-grid
     * inputs, so they render through surfaces instead of occupying built-in
     * pad cells. The generic MVP profile has no external triggers.
     */
    const DEFAULT_TRIGGER_PROFILE = Object.freeze({
        version: 1,
        id: 'generic-triggers',
        name: 'No external pad triggers',
        triggerSlots: Object.freeze([]),
        triggers: Object.freeze([]),
    });

    const DEFAULT_PROFILE = Object.freeze({
        version: 1,
        id: 'generic-3x3',
        name: 'Generic 3x3',
        padProfile: DEFAULT_PAD_PROFILE,
        pedalProfile: DEFAULT_PEDAL_PROFILE,
        triggerProfile: DEFAULT_TRIGGER_PROFILE,
    });

    /** Settings used by the data layer before the settings UI becomes live. */
    const DEFAULT_SETTINGS = Object.freeze({
        padProfileId: DEFAULT_PAD_PROFILE.id,
        pedalProfileId: DEFAULT_PEDAL_PROFILE.id,
        triggerProfileId: DEFAULT_TRIGGER_PROFILE.id,
        profileId: DEFAULT_PROFILE.id,
        showLabels: true,
        hitGroupWindowMs: 8,
        cameraAngle: 0.35,
        sceneTheme: 'default',
        glowStrength: 0.5,
        feedbackIntensity: 0.7,
        timingColors: true,
        hitSparks: true,
        cinematicLighting: true,
        backgroundStyle: 'particles',
        backgroundIntensity: 0.5,
    });

    const SCENE_THEMES = Object.freeze({
        default: Object.freeze({ clear: 0x080b12, fog: 0x101827, floor: 0x0b111a, pad: 0x192536, edge: 0x38516f, tunnel: 0x24425e }),
        midnight: Object.freeze({ clear: 0x050812, fog: 0x0b1220, floor: 0x060a10, pad: 0x111827, edge: 0x334155, tunnel: 0x1e3a5f }),
        charcoal: Object.freeze({ clear: 0x0d0f12, fog: 0x171a1f, floor: 0x090b0e, pad: 0x20242a, edge: 0x525866, tunnel: 0x333a45 }),
        forest: Object.freeze({ clear: 0x07110d, fog: 0x102019, floor: 0x07100b, pad: 0x14251d, edge: 0x3f6b55, tunnel: 0x214736 }),
        deeppurple: Object.freeze({ clear: 0x140a1e, fog: 0x140a1e, floor: 0x0b0610, pad: 0x1f1430, edge: 0x6d4ed8, tunnel: 0x3a1f6e }),
        warmslate: Object.freeze({ clear: 0x1c130b, fog: 0x1c130b, floor: 0x0e0805, pad: 0x24180e, edge: 0x9a6b2f, tunnel: 0x5e3a12 }),
        deepfocus: Object.freeze({ clear: 0x0c0c0d, fog: 0x0c0c0d, floor: 0x060606, pad: 0x101416, edge: 0x4fb3d4, tunnel: 0x2f7fa0 }),
        deepsea: Object.freeze({ clear: 0x06222b, fog: 0x06222b, floor: 0x03141a, pad: 0x082a31, edge: 0x37a3ac, tunnel: 0x0e5a63 }),
        cathode: Object.freeze({ clear: 0x140b03, fog: 0x140b03, floor: 0x0c0702, pad: 0x201409, edge: 0xc58a2a, tunnel: 0x6e4a0e }),
        cathodegreen: Object.freeze({ clear: 0x07301a, fog: 0x07301a, floor: 0x031a0c, pad: 0x082716, edge: 0x2fba62, tunnel: 0x0e6e2a }),
        hearth: Object.freeze({ clear: 0x280806, fog: 0x280806, floor: 0x1a0606, pad: 0x2e100d, edge: 0xd45a32, tunnel: 0x7a2410 }),
    });
    const BACKGROUND_STYLES = Object.freeze(['off', 'particles', 'lights', 'geometric']);
    const BACKGROUND_STYLE_SET = new Set(BACKGROUND_STYLES);

    const PIECE_PALETTE_IDX = Object.freeze({
        kick: -1,
        snare: 0, snare_xstick: 0,
        hh_closed: 7, hh_open: 7, hh_pedal: 7,
        tom_hi: 4, tom_mid: 2, tom_low: 5, tom_floor: 5,
        stack: 1, crash_l: 1, crash_r: 1, splash: 1, china: 1,
        ride: 3, ride_bell: 3, bell: 3,
    });
    const DEFAULT_PALETTE = Object.freeze([0xff2828, 0xffd400, 0x2080ff, 0xff8020, 0x30d040, 0xa040ff, 0xff6bd5, 0x6bffe6]);
    const KICK_COLOR = 0xffa030;
    const PIECE_COLORS = Object.freeze({
        kick: KICK_COLOR,
        snare: DEFAULT_PALETTE[0],
        snare_xstick: DEFAULT_PALETTE[0],
        hh_closed: DEFAULT_PALETTE[7],
        hh_open: DEFAULT_PALETTE[7],
        hh_pedal: DEFAULT_PALETTE[7],
        tom_hi: DEFAULT_PALETTE[4],
        tom_mid: DEFAULT_PALETTE[2],
        tom_low: DEFAULT_PALETTE[5],
        tom_floor: DEFAULT_PALETTE[5],
        stack: DEFAULT_PALETTE[1],
        crash_l: DEFAULT_PALETTE[1],
        crash_r: DEFAULT_PALETTE[1],
        splash: DEFAULT_PALETTE[1],
        china: DEFAULT_PALETTE[1],
        ride: DEFAULT_PALETTE[3],
        ride_bell: DEFAULT_PALETTE[3],
        bell: DEFAULT_PALETTE[3],
    });

    // ---------------------------------------------------------------------
    // Renderer Constants
    // ---------------------------------------------------------------------

    const SCENE_COLORS = Object.freeze({
        clear: 0x080b12,
        fog: 0x101827,
        pad: 0x192536,
        padEdge: 0x38516f,
        surface: 0x7dd3fc,
        inactiveSurface: 0x2d3748,
        inactiveEdge: 0x64748b,
        tunnel: 0x24425e,
        floor: 0x0b111a,
        text: '#dbeafe',
    });
    const PAD_W = 1.18;
    const PAD_H = 0.78;
    const PAD_GAP = 0.16;
    const EXTERNAL_TRIGGER_PAD_DIAMETER = PAD_H;
    const EXTERNAL_TRIGGER_PAD_EDGE_WIDTH = 0.14;
    // Third (outermost) trigger zone - a ring drawn around the edge ring,
    // same thickness as the edge ring for a consistent concentric look.
    const EXTERNAL_TRIGGER_PAD_RIM_WIDTH = 0.14;
    const GRID_CENTER_Y = 1.22;
    const PEDAL_OUTLINE_H = 0.11;
    const FLOOR_Y = -0.72;
    const TUNNEL_DEPTH = 22;
    const TUNNEL_BACK_LIFT = 5.0;
    const TUNNEL_BACK_X_OFFSET = 14.0;
    const HIGHWAY_PITCH = 0;
    const HIGHWAY_Y_OFFSET = 0;
    const HIGHWAY_Z_OFFSET = 0;
    const CAMERA_PAN_X = 1.35;
    const CAMERA_PAN_Y = 0.56;
    // Shared "colored outline with a faint fill" look for every plane-shaped
    // assigned target zone - pads, and the pedal/trigger-outline surfaces
    // that use the same rectangular addPlaneSurface geometry (see
    // applyTargetZoneStyle in 04-renderer.js). Circular/ring external
    // trigger zones don't need this: addCircleSurface/addRingSurface
    // already fill with the routed color directly instead of a neutral
    // theme.pad base, so they read correctly without a separate pass.
    const TARGET_ZONE_FILL_OPACITY = 0.1;
    const TARGET_ZONE_EDGE_OPACITY = 0.9;
    // Peak opacity of the whole-hit-group layout-preview outline, reached
    // while it's still far away. It fades linearly to fully 0 as the note
    // approaches the target (see placeLayoutPreview), rather than staying at
    // a flat opacity all the way to the threshold.
    const LAYOUT_PREVIEW_GROUP_OPACITY = 0.45;
    // Extra margin added around the pad grid's own tight bounding box when
    // sizing the layout-preview outline, so the frame reads as a border
    // around the hit group rather than touching the outermost gems.
    const LAYOUT_PREVIEW_GROUP_MARGIN = 0.14;
    // NOTE_SPEED is the purely spatial knob: how many world units of depth
    // correspond to one second of chart-time gap between notes. Raising it
    // (from an original 7.25) spreads notes that are close together in time
    // further apart in 3D space, so dense/adjacent hits read as visually
    // distinct instead of overlapping - it does NOT change how much real
    // reaction time a note is visible for (see NOTE_AHEAD_BEATS below for
    // that). A note becomes visible at depth z = -aheadSec * NOTE_SPEED
    // (aheadSec computed per-frame from the chart's local tempo - see
    // updateNoteAheadFromTempo); placeNote normalizes its own growth curve
    // against that same computed depth (not the fixed TUNNEL_DEPTH used only
    // for the cosmetic guide-line wireframe/camera look-at target), so notes
    // always spawn at exactly progress=0 regardless of tempo.
    const NOTE_SPEED = 12.0;
    const NOTE_GEM_DEPTH = 0.1;
    const NOTE_GEM_CORNER_RADIUS = 0.18;
    // Layout-preview outline's own corner radius - fixed, at individual-gem
    // scale, rather than proportional to the whole grid's (much larger)
    // width/height. buildFrameGeometry's default (Math.min(w, h) *
    // NOTE_GEM_CORNER_RADIUS, using the outline's own full outer w/h) gave
    // the outline a corner radius several times larger than any single
    // gem's own rounding - the rounded corner then cut inward *more* than
    // LAYOUT_PREVIEW_GROUP_MARGIN pushed the box outward, letting a corner
    // gem touch or overlap the outline despite the straight edges having a
    // clean gap.
    const LAYOUT_PREVIEW_GROUP_CORNER_RADIUS = NOTE_GEM_CORNER_RADIUS * Math.min(PAD_W, PAD_H);
    const NOTE_GEM_CURVE_SEGMENTS = 8;
    const NOTE_GEM_BODY_Z_OFFSET = 0.08;
    const NOTE_GEM_FACE_Z_OFFSET = NOTE_GEM_BODY_Z_OFFSET + NOTE_GEM_DEPTH / 2 + 0.008;
    // Reaction time is expressed in beats, not a flat seconds value, so it
    // scales with the chart's own tempo (updateNoteAheadFromTempo derives
    // the current seconds-per-beat from bundle.beats each frame). A value a
    // hair off a "nice" fraction of a beat is deliberate - it keeps a hit
    // group sent right at that fraction's own boundary from ever
    // double-showing as still-resolving right at the edge.
    const NOTE_AHEAD_BEATS = 1.99;
    // Used when the chart has no usable beat-grid data (fewer than 2 beats,
    // e.g. no song_timeline). Matches the flat value this replaced.
    const NOTE_AHEAD_FALLBACK_SEC = 2.0;
    // How long a note keeps rendering/moving past the hit plane before it's
    // culled. No hit detection exists yet (post-MVP), so every note passes
    // through unhandled - it keeps a brief bit of motion instead of freezing.
    // Must be at least NOTE_PAST_THRESHOLD_FADE_SEC so the past-threshold
    // opacity fade (see placeNote's isPastThreshold branch) always finishes
    // reaching zero before the note is culled, instead of the mesh
    // disappearing mid-fade.
    const NOTE_BEHIND_SEC = 0.25;
    // How long a note takes to fade in from fully transparent after
    // spawning. Gems are drawn at their real target size from the moment
    // they spawn (no separate world-space size-growth curve - see
    // placeNote's comment on why that curve was removed), so without this
    // fade a gem would otherwise pop in abruptly at full opacity and full
    // size the instant it enters the lookahead window.
    const NOTE_SPAWN_FADE_SEC = 0.25;
    // Normal (non-repeat) gem opacity - body is the extruded block, face is
    // the flat front label surface (see placeNote/acquireNoteMesh).
    const NOTE_BODY_OPACITY = 0.82;
    const NOTE_FACE_OPACITY = 0.98;
    // Repeat-note gems (same surface hit again within the immediately
    // previous hit group - see placeNote's isRepeat) render dimmer than a
    // fresh gem, as a pad-grid-pattern cue (see PLANNING.md).
    const NOTE_REPEAT_BODY_OPACITY = 0.24;
    const NOTE_REPEAT_FACE_OPACITY = 0.2;
    // Gray the instant a note passes its target - no fade in from a
    // brighter starting point (see placeNote's isPastThreshold branch) -
    // signaling "unhandled" without implying a miss judgement, since no hit
    // detection exists yet. A white threshold-crossing flash used to play
    // here too, but even at a short duration it's normal- (not additive-)
    // blended toward white, so it read as a lingering bright moment right
    // when gems are supposed to go dim immediately - removed (see
    // placeNote's flash suppression under isPastThreshold).
    const NOTE_PAST_THRESHOLD_COLOR = 0x808080;
    // Past-threshold gems always start their fade at the dimmer
    // NOTE_REPEAT_*_OPACITY level - even a fresh (non-repeat) gem's own
    // brighter NOTE_*_OPACITY read as too bright/lingering the instant
    // after crossing - then ramp linearly down to fully invisible over this
    // many seconds (see placeNote's isPastThreshold branch) - the rate is
    // deliberately linear for now; may become eased later.
    const NOTE_PAST_THRESHOLD_FADE_SEC = 0.25;
    const SPARK_COUNT = 192;
    const KICK_SHAKE_DECAY = 14;
    const KICK_SHAKE_MAGNITUDE = 0.09;
    const TIMING_OK_COLOR = 0x22ff88;
    const TIMING_EARLY_COLOR = 0x35d6ff;
    const TIMING_LATE_COLOR = 0xffb84d;
    const RENDER_CURSOR_REBASE_SEC = 0.75;

    // ---------------------------------------------------------------------
    // Settings Keys
    // ---------------------------------------------------------------------

    /** localStorage keys are namespaced so this plugin never collides with drum_h3d. */
    const LS_KEYS = Object.freeze({
        profile: 'multipad_h3d_profile_v1',
        padProfileId: 'multipad_h3d_pad_profile',
        pedalProfileId: 'multipad_h3d_pedal_profile',
        triggerProfileId: 'multipad_h3d_trigger_profile',
        showLabels: 'multipad_h3d_show_labels',
        hitGroupWindowMs: 'multipad_h3d_hit_group_window_ms',
        cameraAngle: 'multipad_h3d_camera_angle',
        sceneTheme: 'multipad_h3d_scene_theme',
        glowStrength: 'multipad_h3d_glow_strength',
        feedbackIntensity: 'multipad_h3d_feedback_intensity',
        timingColors: 'multipad_h3d_timing_colors',
        hitSparks: 'multipad_h3d_hit_sparks',
        cinematicLighting: 'multipad_h3d_cinematic_lighting',
        backgroundStyle: 'multipad_h3d_background_style',
        backgroundIntensity: 'multipad_h3d_background_intensity',
        backgroundAmbience: 'multipad_h3d_background_ambience',
    });

    // ---------------------------------------------------------------------
    // Shared Utility Helpers
    // ---------------------------------------------------------------------

    /**
     * Coerce a user-controlled numeric setting into a bounded value.
     *
     * @param {*} value - Raw input from localStorage, chart data, or tests.
     * @param {number} min - Inclusive lower bound.
     * @param {number} max - Inclusive upper bound.
     * @param {number} fallback - Value returned for NaN/non-finite input.
     * @returns {number}
     */
    function clampNumber(value, min, max, fallback) {
        const n = Number(value);
        if (!Number.isFinite(n)) return fallback;
        return Math.min(max, Math.max(min, n));
    }

    /**
     * Sanitize id-like fields owned by profile data.
     *
     * This is for `profile.id`, `pad.id`, `pedal.id`, and external `trigger.id`.
     * Drum piece ids are not sanitized through this path; they are accepted
     * only when they match the canonical `PIECE_SET`.
     *
     * @param {*} value - Candidate profile-owned id.
     * @param {string} fallback - Known-safe id.
     * @returns {string}
     */
    function sanitizeProfileId(value, fallback) {
        if (typeof value !== 'string') return fallback;
        const id = value.trim().slice(0, 64);
        return /^[A-Za-z0-9_.:-]+$/.test(id) ? id : fallback;
    }

    /**
     * Sanitize short human-facing text supplied by profile data.
     *
     * This is for profile names plus pad/pedal/trigger labels. Hit labels are
     * generated from canonical piece labels during projection, not accepted
     * from chart data.
     *
     * @param {*} value - Candidate profile name or pad/pedal/trigger label.
     * @param {string} fallback - Text used when the candidate is empty/invalid.
     * @returns {string}
     */
    function sanitizeProfileDisplayText(value, fallback) {
        if (typeof value !== 'string') return fallback;
        const label = value.trim().replace(/\s+/g, ' ').slice(0, 32);
        return label || fallback;
    }

    /**
     * Convert a normalized CSS hex color to a Three.js numeric color.
     *
     * @param {*} color - Candidate `#rrggbb` color string.
     * @returns {number|null} Numeric color, or null when invalid.
     */
    function colorHexFromCss(color) {
        if (typeof color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(color)) return null;
        return Number.parseInt(color.slice(1), 16);
    }

    function cssColorFromHex(hex) {
        return '#' + Number(hex || 0).toString(16).padStart(6, '0').slice(-6);
    }

    /**
     * Resolve a profile-owned CSS color field: the raw value verbatim
     * (lowercased) when it's a valid `#rrggbb` string, otherwise a CSS
     * string built from `fallbackHex`.
     *
     * Shared by `validatePadProfile`, `validatePedalProfile`, and
     * `validateTriggerProfile` - each still picks its own `fallbackHex`
     * (their fallback semantics genuinely differ: pad/trigger fall back to
     * their first assigned piece's palette color with different defaults
     * when inactive, pedal always has a piece to fall back to), but the
     * "is this a valid hex string, otherwise format the fallback" check no
     * longer needs its own copy at each call site.
     *
     * @param {*} rawColor - Candidate `#rrggbb` string from profile data.
     * @param {number} fallbackHex - Numeric color used when rawColor is invalid.
     * @returns {string} Lowercase `#rrggbb` CSS color.
     */
    function sanitizeProfileColor(rawColor, fallbackHex) {
        return colorHexFromCss(rawColor) !== null ? rawColor.toLowerCase() : cssColorFromHex(fallbackHex);
    }

    /**
     * Default display label for a pad/pedal/trigger from its first assigned
     * piece - the canonical short label when known, otherwise the piece id
     * uppercased. Empty when no piece is assigned yet (inactive surface).
     *
     * @param {Array<string>} pieces - A pad/pedal/trigger's assigned pieces.
     * @returns {string}
     */
    function defaultLabelForPieces(pieces) {
        return pieces[0] ? (PIECE_LABELS[pieces[0]] || pieces[0].toUpperCase()) : '';
    }

    /**
     * Binary search a sorted array for the first entry at or after `minTime`,
     * reading the time from `field`. Shared by `lowerBoundHitEvents` (hit
     * events, keyed by `.t`) and `lowerBoundTimeField` (beats/anchors/
     * sections, keyed by `.time`) so the two callers can't drift apart.
     *
     * @param {Array<object>} entries - Sorted entries.
     * @param {number} minTime - Earliest time to find.
     * @param {string} field - Property name holding each entry's time.
     * @returns {number} Start index into `entries`.
     */
    function lowerBoundByField(entries, minTime, field) {
        let lo = 0;
        let hi = Array.isArray(entries) ? entries.length : 0;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (entries[mid][field] < minTime) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    }

    /**
     * Find the first sorted hit event whose time is at or after `minTime`.
     *
     * @param {Array<object>} hitEvents - Sorted projected hit events.
     * @param {number} minTime - Earliest visible event time.
     * @returns {number} Start index into `hitEvents`.
     */
    function lowerBoundHitEvents(hitEvents, minTime) {
        return lowerBoundByField(hitEvents, minTime, 't');
    }

    /**
     * Binary search a `.time`-keyed array (e.g. the host bundle's `beats`)
     * for the first entry at or after `minTime` - the `.time` field
     * beats/anchors/sections use instead of `.t`.
     *
     * @param {Array<object>} entries - Sorted entries with a `.time` field.
     * @param {number} minTime - Earliest time to find.
     * @returns {number} Start index into `entries`.
     */
    function lowerBoundTimeField(entries, minTime) {
        return lowerBoundByField(entries, minTime, 'time');
    }

    function normalizeTimingStatus(value) {
        if (typeof value !== 'string') return '';
        const status = value.trim().toUpperCase();
        return status === 'EARLY' || status === 'LATE' || status === 'OK' ? status : '';
    }

    // ---------------------------------------------------------------------
    // Profile Cloning and Layout Helpers
    // ---------------------------------------------------------------------

    /**
     * Return a mutable copy of a pad profile for callers/tests.
     *
     * @param {object} profile - Validated pad profile.
     * @returns {object}
     */
    function clonePadProfile(profile) {
        return {
            version: 1,
            id: profile.id,
            name: profile.name,
            rows: profile.rows,
            cols: profile.cols,
            pads: profile.pads.map(pad => ({
                id: pad.id,
                row: pad.row,
                col: pad.col,
                label: pad.label,
                pieces: pad.pieces.slice(),
                color: pad.color,
            })),
            fallbacks: Object.assign({}, profile.fallbacks || {}),
        };
    }

    /**
     * Return a mutable copy of a pedal profile for callers/tests.
     *
     * @param {object} profile - Validated pedal profile.
     * @returns {object}
     */
    function clonePedalProfile(profile) {
        return {
            version: 1,
            id: profile.id,
            name: profile.name,
            pedals: profile.pedals.map(pedal => ({
                id: pedal.id,
                surface: pedal.surface,
                label: pedal.label,
                pieces: pedal.pieces.slice(),
                color: pedal.color,
            })),
        };
    }

    /**
     * Return a mutable copy of an external pad trigger profile.
     *
     * @param {object} profile - Validated trigger profile.
     * @returns {object}
     */
    function cloneTriggerProfile(profile) {
        return {
            version: 1,
            id: profile.id,
            name: profile.name,
            triggers: profile.triggers.map(trigger => ({
                id: trigger.id,
                surface: trigger.surface,
                label: trigger.label,
                pieces: trigger.pieces.slice(),
                color: trigger.color,
            })),
            triggerSlots: (profile.triggerSlots || []).map(slot => ({
                id: slot.id,
                zones: slot.zones,
            })),
        };
    }

    function inferTriggerSlots(triggers) {
        const surfaces = new Set((Array.isArray(triggers) ? triggers : []).map(trigger => trigger && trigger.surface).filter(Boolean));
        const slots = [];
        if (surfaces.has('external-left-center') || surfaces.has('external-left-edge') || surfaces.has('external-left-rim')) {
            slots.push({ id: 'trigger-1', zones: surfaces.has('external-left-rim') ? 3 : (surfaces.has('external-left-edge') ? 2 : 1) });
        }
        if (surfaces.has('external-right-center') || surfaces.has('external-right-edge') || surfaces.has('external-right-rim')) {
            slots.push({ id: 'trigger-2', zones: surfaces.has('external-right-rim') ? 3 : (surfaces.has('external-right-edge') ? 2 : 1) });
        }
        return slots;
    }

    /**
     * Return a stable key for the pad geometry that should currently be drawn.
     *
     * Includes each pad's full `pieces` list, not just `label` - a pad's
     * label is derived from `pieces[0]` only (see `defaultLabelForPieces`),
     * so adding/removing a non-first piece leaves `label` unchanged. The
     * renderer's on-highway label now shows every piece (one line each),
     * so the cache key must change whenever `pieces` does, or the surface
     * grid rebuild that key gates would skip rendering the new piece list.
     *
     * @param {object} profile - Validated or raw pad profile.
     * @returns {string} Stable layout key.
     */
    function padProfileLayoutKey(profile) {
        const valid = validatePadProfile(profile) || clonePadProfile(DEFAULT_PAD_PROFILE);
        const pads = valid.pads
            .map(pad => [pad.id, pad.row, pad.col, pad.label, pad.pieces.join(',')].join(':'))
            .sort()
            .join('|');
        return [valid.id, valid.rows, valid.cols, pads].join('|');
    }

    /**
     * Build pure render-surface descriptors for a pad profile.
     *
     * @param {object} profile - Validated or raw pad profile.
     * @param {object} [pedalProfile] - Validated or raw pedal profile.
     * @param {object} [triggerProfile] - Validated or raw trigger profile.
     * @returns {{layoutKey: string, rows: number, cols: number, gridW: number, gridH: number, surfaces: Array<object>}}
     */
    function buildSurfaceLayout(profile, pedalProfile, triggerProfile) {
        const valid = validatePadProfile(profile) || clonePadProfile(DEFAULT_PAD_PROFILE);
        const pedals = validatePedalProfile(pedalProfile) || clonePedalProfile(DEFAULT_PEDAL_PROFILE);
        const triggers = validateTriggerProfile(triggerProfile) || cloneTriggerProfile(DEFAULT_TRIGGER_PROFILE);
        const activeSurfaceColor = Object.create(null);
        // Pieces mapped onto each pedal/trigger surface key, aggregated
        // across every pedal/trigger entry that targets it (normally just
        // one, but validatePedalProfile doesn't dedup surfaces the way pads
        // dedup coordinates, so two pedals can share a surface) - read by
        // the renderer to build target labels (see buildSurfaceLabel in
        // 04-renderer.js), same purpose `pad.pieces` already serves for pads.
        const activeSurfacePieces = Object.create(null);
        for (const pedal of pedals.pedals) {
            if (pedal.pieces.length > 0) {
                (activeSurfacePieces[pedal.surface] || (activeSurfacePieces[pedal.surface] = [])).push(...pedal.pieces);
            }
            if (pedal.pieces.length > 0 && activeSurfaceColor[pedal.surface] == null) {
                const profileColor = colorHexFromCss(pedal.color);
                activeSurfaceColor[pedal.surface] = profileColor !== null
                    ? profileColor
                    : (PIECE_COLORS[pedal.pieces[0]] || SCENE_COLORS.surface);
            }
        }
        for (const trigger of triggers.triggers) {
            if (trigger.pieces.length > 0) {
                (activeSurfacePieces[trigger.surface] || (activeSurfacePieces[trigger.surface] = [])).push(...trigger.pieces);
            }
            if (trigger.pieces.length > 0 && activeSurfaceColor[trigger.surface] == null) {
                const profileColor = colorHexFromCss(trigger.color);
                activeSurfaceColor[trigger.surface] = profileColor !== null
                    ? profileColor
                    : (PIECE_COLORS[trigger.pieces[0]] || 0xa78bfa);
            }
        }
        const rows = Math.max(1, valid.rows);
        const cols = Math.max(1, valid.cols);
        const gridW = cols * PAD_W + (cols - 1) * PAD_GAP;
        const gridH = rows * PAD_H + (rows - 1) * PAD_GAP;
        const surfaces = [];

        for (const pad of valid.pads) {
            const active = pad.pieces.length > 0;
            const profileColor = colorHexFromCss(pad.color);
            const color = profileColor !== null
                ? profileColor
                : (active ? (PIECE_COLORS[pad.pieces[0]] || SCENE_COLORS.surface) : SCENE_COLORS.inactiveSurface);
            surfaces.push({
                key: 'pad:' + pad.id,
                kind: 'pad',
                shape: 'plane',
                x: (pad.col - (cols - 1) / 2) * (PAD_W + PAD_GAP),
                y: GRID_CENTER_Y + ((rows - 1) / 2 - pad.row) * (PAD_H + PAD_GAP),
                w: PAD_W,
                h: PAD_H,
                color,
                active,
                opacity: active ? 0.82 : 0.34,
                pad,
                pieces: pad.pieces,
            });
        }

        const topY = GRID_CENTER_Y + gridH / 2 + 0.24;
        const bottomY = GRID_CENTER_Y - gridH / 2 - 0.24;
        const sideX = gridW / 2 + 0.25;
        const externalPadRadius = EXTERNAL_TRIGGER_PAD_DIAMETER / 2;
        const externalPadCenterRadius = externalPadRadius - EXTERNAL_TRIGGER_PAD_EDGE_WIDTH;
        const externalPadRimRadius = externalPadRadius + EXTERNAL_TRIGGER_PAD_RIM_WIDTH;
        const externalPadX = gridW / 2 + 0.25 + 0.11 / 2 + externalPadRimRadius + 0.22;
        function controlledSurface(key, activeOpacity, inactiveOpacity) {
            const active = activeSurfaceColor[key] != null;
            return {
                active,
                color: active ? activeSurfaceColor[key] : SCENE_COLORS.inactiveSurface,
                opacity: active ? activeOpacity : inactiveOpacity,
                pieces: activeSurfacePieces[key] || [],
            };
        }
        const top = controlledSurface('outline-top', 0.2, 0.08);
        const bottom = controlledSurface('outline-bottom', 0.22, 0.08);
        const left = controlledSurface('outline-left', 0.16, 0.06);
        const right = controlledSurface('outline-right', 0.16, 0.06);
        const leftCenter = controlledSurface('external-left-center', 0.48, 0.16);
        const leftEdge = controlledSurface('external-left-edge', 0.82, 0.18);
        const leftRim = controlledSurface('external-left-rim', 0.82, 0.18);
        const rightCenter = controlledSurface('external-right-center', 0.48, 0.16);
        const rightEdge = controlledSurface('external-right-edge', 0.82, 0.18);
        const rightRim = controlledSurface('external-right-rim', 0.82, 0.18);
        surfaces.push(
            { key: 'outline-top', kind: 'pedal-outline', shape: 'plane', x: 0, y: topY, w: gridW, h: PEDAL_OUTLINE_H, color: top.color, active: top.active, opacity: top.opacity, pieces: top.pieces },
            { key: 'outline-bottom', kind: 'pedal-outline', shape: 'plane', x: 0, y: bottomY, w: gridW, h: PEDAL_OUTLINE_H, color: bottom.color, active: bottom.active, opacity: bottom.opacity, pieces: bottom.pieces },
            { key: 'outline-left', kind: 'trigger-outline', shape: 'plane', x: -sideX, y: GRID_CENTER_Y, w: 0.11, h: gridH, color: left.color, active: left.active, opacity: left.opacity, pieces: left.pieces },
            { key: 'outline-right', kind: 'trigger-outline', shape: 'plane', x: sideX, y: GRID_CENTER_Y, w: 0.11, h: gridH, color: right.color, active: right.active, opacity: right.opacity, pieces: right.pieces },
            { key: 'external-left-center', kind: 'external-trigger-center', shape: 'circle', x: -externalPadX, y: GRID_CENTER_Y, w: externalPadCenterRadius * 2, h: externalPadCenterRadius * 2, radius: externalPadCenterRadius, color: leftCenter.color, active: leftCenter.active, opacity: leftCenter.opacity, pieces: leftCenter.pieces },
            { key: 'external-left-edge', kind: 'external-trigger-edge', shape: 'ring', x: -externalPadX, y: GRID_CENTER_Y, w: EXTERNAL_TRIGGER_PAD_DIAMETER, h: EXTERNAL_TRIGGER_PAD_DIAMETER, innerRadius: externalPadCenterRadius, outerRadius: externalPadRadius, color: leftEdge.color, active: leftEdge.active, opacity: leftEdge.opacity, pieces: leftEdge.pieces },
            { key: 'external-left-rim', kind: 'external-trigger-rim', shape: 'ring', x: -externalPadX, y: GRID_CENTER_Y, w: externalPadRimRadius * 2, h: externalPadRimRadius * 2, innerRadius: externalPadRadius, outerRadius: externalPadRimRadius, color: leftRim.color, active: leftRim.active, opacity: leftRim.opacity, pieces: leftRim.pieces },
            { key: 'external-right-center', kind: 'external-trigger-center', shape: 'circle', x: externalPadX, y: GRID_CENTER_Y, w: externalPadCenterRadius * 2, h: externalPadCenterRadius * 2, radius: externalPadCenterRadius, color: rightCenter.color, active: rightCenter.active, opacity: rightCenter.opacity, pieces: rightCenter.pieces },
            { key: 'external-right-edge', kind: 'external-trigger-edge', shape: 'ring', x: externalPadX, y: GRID_CENTER_Y, w: EXTERNAL_TRIGGER_PAD_DIAMETER, h: EXTERNAL_TRIGGER_PAD_DIAMETER, innerRadius: externalPadCenterRadius, outerRadius: externalPadRadius, color: rightEdge.color, active: rightEdge.active, opacity: rightEdge.opacity, pieces: rightEdge.pieces },
            { key: 'external-right-rim', kind: 'external-trigger-rim', shape: 'ring', x: externalPadX, y: GRID_CENTER_Y, w: externalPadRimRadius * 2, h: externalPadRimRadius * 2, innerRadius: externalPadRadius, outerRadius: externalPadRimRadius, color: rightRim.color, active: rightRim.active, opacity: rightRim.opacity, pieces: rightRim.pieces }
        );

        return {
            layoutKey: padProfileLayoutKey(valid) + '|' + pedals.pedals.map(pedal => [pedal.id, pedal.surface, pedal.pieces.join(','), pedal.color].join(':')).join('|') + '|' + triggers.triggers.map(trigger => [trigger.id, trigger.surface, trigger.pieces.join(','), trigger.color].join(':')).join('|'),
            rows,
            cols,
            gridW,
            gridH,
            surfaces,
        };
    }

    // ---------------------------------------------------------------------
    // Profile Validation
    // ---------------------------------------------------------------------

    /**
     * Validate and normalize a pad layout.
     *
     * The profile accepts explicit m x n layouts and any known drum piece id -
     * pieces are no longer restricted by category; any piece (including kick
     * and hh_pedal) may be assigned to a pad, a pedal, or an external trigger.
     * Invalid top-level dimensions reject the whole profile so the caller can
     * fall back to the known-good default instead of guessing.
     * Unknown pieces, duplicate pad coordinates, duplicate pad ids, duplicate
     * piece assignments, and out-of-bounds pads are dropped instead of throwing.
     * Pads with no assigned pieces remain valid inactive pads so the settings
     * UI and 3D highway can show them grayed out.
     *
     * @param {*} raw - Untrusted profile-like data.
     * @param {Set<string>} [sharedAssignedPieces] - Piece-uniqueness set
     *   shared across pad/pedal/trigger validation for one combined profile
     *   (see validateMultipadProfile) - a piece already claimed here is
     *   skipped, and every piece accepted here is added to it, so the same
     *   piece can never end up live on two targets at once (that would
     *   otherwise route the same chart hit to two on-screen targets, only
     *   one of which the routing priority in projectDrumTab ever actually
     *   fires). Defaults to a fresh, call-local Set when validating a pad
     *   profile on its own (dedup then only applies within this pad profile).
     * @returns {object|null} Normalized profile or null when unusable.
     */
    function validatePadProfile(raw, sharedAssignedPieces) {
        if (!raw || typeof raw !== 'object') return null;
        const rows = raw.rows;
        const cols = raw.cols;
        if (!Number.isInteger(rows) || !Number.isInteger(cols)) return null;
        if (rows < 1 || rows > 12 || cols < 1 || cols > 12) return null;
        const rawPads = Array.isArray(raw.pads) ? raw.pads : null;
        if (!rawPads) return null;

        const pads = [];
        const occupied = new Set();
        const usedPadIds = new Set();
        const assignedPieces = sharedAssignedPieces || new Set();
        for (let i = 0; i < rawPads.length; i++) {
            const pad = rawPads[i];
            if (!pad || typeof pad !== 'object') continue;
            const row = pad.row;
            const col = pad.col;
            if (!Number.isInteger(row) || !Number.isInteger(col)) continue;
            if (row < 0 || row >= rows || col < 0 || col >= cols) continue;
            const coordKey = row + ':' + col;
            if (occupied.has(coordKey)) continue;
            const defaultId = String(row * cols + col + 1);
            const padId = sanitizeProfileId(pad.id, defaultId);
            if (usedPadIds.has(padId)) continue;

            const pieces = [];
            const rawPieces = Array.isArray(pad.pieces) ? pad.pieces : [];
            for (const piece of rawPieces) {
                if (!PIECE_SET.has(piece)) continue;
                if (assignedPieces.has(piece)) continue;
                assignedPieces.add(piece);
                pieces.push(piece);
            }
            occupied.add(coordKey);
            usedPadIds.add(padId);
            const color = sanitizeProfileColor(
                pad.color,
                pieces[0] ? (PIECE_COLORS[pieces[0]] || SCENE_COLORS.surface) : SCENE_COLORS.inactiveSurface
            );
            pads.push({
                id: padId,
                row,
                col,
                label: sanitizeProfileDisplayText(pad.label, defaultLabelForPieces(pieces)),
                pieces,
                color,
            });
        }
        if (pads.length === 0) return null;

        // Fallback substitution is intentionally still pedal-piece-free: it's
        // a "no direct pad assignment? borrow this other piece's pad" kit
        // convenience for near-identical drum variants (open/closed hi-hat,
        // tom sizes, cymbal variants), never something kick/hh_pedal have
        // participated in - unrelated to (and not loosened by) the direct
        // per-piece assignment restriction lifted above.
        const fallbacks = Object.create(null);
        const rawFallbacks = raw.fallbacks && typeof raw.fallbacks === 'object' ? raw.fallbacks : {};
        for (const piece of Object.keys(rawFallbacks)) {
            const fallbackPiece = rawFallbacks[piece];
            if (PEDAL_PIECE_SET.has(piece) || PEDAL_PIECE_SET.has(fallbackPiece)) continue;
            if (!PIECE_SET.has(piece) || !PIECE_SET.has(fallbackPiece)) continue;
            fallbacks[piece] = fallbackPiece;
        }

        return {
            version: 1,
            id: sanitizeProfileId(raw.id, DEFAULT_PAD_PROFILE.id),
            name: sanitizeProfileDisplayText(raw.name, 'Custom pad grid'),
            rows,
            cols,
            pads,
            fallbacks,
        };
    }

    /**
     * Validate and normalize the pedal profile.
     *
     * Pedal surfaces accept any known drum piece id, not just kick/hh_pedal -
     * any piece may be assigned to a pad, a pedal, or an external trigger.
     * Each pedal still holds at most one piece. Pedals with no assigned
     * pieces remain valid inactive pedals. A piece already claimed by an
     * earlier pedal (or, via `sharedAssignedPieces`, by a pad or trigger in
     * the same combined profile) is dropped rather than duplicated - two
     * pedals can no longer both map to kick, since a piece live on two
     * targets would only ever actually fire from one of them (see
     * projectDrumTab's pedal > trigger > pad routing priority) while the
     * other still displayed as if assigned.
     *
     * @param {*} raw - Untrusted profile-like data.
     * @param {Set<string>} [sharedAssignedPieces] - See validatePadProfile's
     *   parameter of the same name.
     * @returns {object|null} Normalized pedal profile or null when unusable.
     */
    function validatePedalProfile(raw, sharedAssignedPieces) {
        if (!raw || typeof raw !== 'object') return null;
        const rawPedals = Array.isArray(raw.pedals) ? raw.pedals : null;
        if (!rawPedals) return null;

        const assignedPieces = sharedAssignedPieces || new Set();
        // Surface dedup, mirroring validateTriggerProfile's occupiedSurfaces:
        // now that any piece (not just hh_pedal/kick) can land on a pedal,
        // two pedals requesting/defaulting to the same surface is reachable
        // (e.g. two non-hh_pedal pieces both default to 'outline-bottom').
        // Falling back to the other PEDAL_SURFACES entry instead of just
        // dropping the pedal keeps both pedals usable.
        const occupiedSurfaces = new Set();
        const pedals = [];
        for (let i = 0; i < rawPedals.length; i++) {
            if (pedals.length >= 2) break;
            const pedal = rawPedals[i];
            if (!pedal || typeof pedal !== 'object') continue;

            const pieces = [];
            const rawPieces = Array.isArray(pedal.pieces) ? pedal.pieces : [];
            for (const piece of rawPieces) {
                if (!PIECE_SET.has(piece)) continue;
                if (assignedPieces.has(piece)) continue;
                assignedPieces.add(piece);
                pieces.push(piece);
                break;
            }
            const defaultPiece = pieces[0] || (i === 0 ? 'hh_pedal' : 'kick');
            const requestedSurface = typeof pedal.surface === 'string' ? pedal.surface.trim() : '';
            let surface = PEDAL_SURFACE_SET.has(requestedSurface)
                ? requestedSurface
                : (defaultPiece === 'hh_pedal' ? 'outline-top' : 'outline-bottom');
            if (occupiedSurfaces.has(surface)) {
                surface = PEDAL_SURFACES.find(candidate => !occupiedSurfaces.has(candidate)) || surface;
            }
            occupiedSurfaces.add(surface);
            const color = sanitizeProfileColor(pedal.color, PIECE_COLORS[defaultPiece] || SCENE_COLORS.inactiveSurface);
            pedals.push({
                id: sanitizeProfileId(pedal.id, 'pedal-' + (i + 1)),
                surface,
                label: sanitizeProfileDisplayText(pedal.label, defaultLabelForPieces(pieces)),
                pieces,
                color,
            });
        }

        return {
            version: 1,
            id: sanitizeProfileId(raw.id, DEFAULT_PEDAL_PROFILE.id),
            name: sanitizeProfileDisplayText(raw.name, 'Custom pedals'),
            pedals,
        };
    }

    /**
     * Validate and normalize the external pad trigger profile.
     *
     * These are off-grid pad inputs such as a plugged-in snare pad. They use
     * surface tokens like pedals do, and accept any known drum piece id -
     * any piece may be assigned to a pad, a pedal, or an external trigger.
     * Trigger zones with no assigned pieces remain valid inactive surfaces.
     *
     * @param {*} raw - Untrusted profile-like data.
     * @param {Set<string>} [sharedAssignedPieces] - See validatePadProfile's
     *   parameter of the same name.
     * @returns {object|null} Normalized trigger profile or null when unusable.
     */
    function validateTriggerProfile(raw, sharedAssignedPieces) {
        if (!raw || typeof raw !== 'object') return null;
        const rawTriggers = Array.isArray(raw.triggers) ? raw.triggers : null;
        if (!rawTriggers) return null;

        const triggers = [];
        const assignedPieces = sharedAssignedPieces || new Set();
        const occupiedSurfaces = new Set();
        const usedTriggerIds = new Set();
        for (let i = 0; i < rawTriggers.length; i++) {
            const trigger = rawTriggers[i];
            if (!trigger || typeof trigger !== 'object') continue;
            if (triggers.length >= 6) break;
            const surface = typeof trigger.surface === 'string' ? trigger.surface.trim() : '';
            if (!TRIGGER_SURFACE_SET.has(surface)) continue;
            if (occupiedSurfaces.has(surface)) continue;

            const defaultId = 'trigger-' + (triggers.length + 1);
            const triggerId = sanitizeProfileId(trigger.id, defaultId);
            if (usedTriggerIds.has(triggerId)) continue;

            const pieces = [];
            const rawPieces = Array.isArray(trigger.pieces) ? trigger.pieces : [];
            for (const piece of rawPieces) {
                if (!PIECE_SET.has(piece)) continue;
                if (assignedPieces.has(piece)) continue;
                assignedPieces.add(piece);
                pieces.push(piece);
            }
            occupiedSurfaces.add(surface);
            usedTriggerIds.add(triggerId);
            const color = sanitizeProfileColor(
                trigger.color,
                pieces[0] ? (PIECE_COLORS[pieces[0]] || 0xa78bfa) : SCENE_COLORS.inactiveSurface
            );
            triggers.push({
                id: triggerId,
                surface,
                label: sanitizeProfileDisplayText(trigger.label, defaultLabelForPieces(pieces)),
                pieces,
                color,
            });
        }

        const triggerSlots = [];
        const rawSlots = Array.isArray(raw.triggerSlots) ? raw.triggerSlots : inferTriggerSlots(triggers);
        const usedSlotIds = new Set();
        for (const slot of rawSlots) {
            if (!slot || typeof slot !== 'object') continue;
            const id = sanitizeProfileId(slot.id, '');
            if (id !== 'trigger-1' && id !== 'trigger-2') continue;
            if (usedSlotIds.has(id)) continue;
            usedSlotIds.add(id);
            triggerSlots.push({ id, zones: Math.round(clampNumber(slot.zones, 1, 3, 1)) });
            if (triggerSlots.length >= 2) break;
        }

        return {
            version: 1,
            id: sanitizeProfileId(raw.id, DEFAULT_TRIGGER_PROFILE.id),
            name: sanitizeProfileDisplayText(raw.name, 'Custom external triggers'),
            triggers,
            triggerSlots,
        };
    }

    // ---------------------------------------------------------------------
    // Settings Persistence
    // ---------------------------------------------------------------------

    /**
     * Safely read localStorage. Browsers may throw when storage is blocked, and
     * the VM tests provide no storage at all.
     *
     * @param {string} key
     * @returns {string|null}
     */
    function readStorageValue(key) {
        try {
            if (typeof localStorage === 'undefined' || !localStorage) return null;
            return localStorage.getItem(key);
        } catch (_) {
            return null;
        }
    }

    /**
     * Best-effort localStorage write used by settings controls.
     *
     * @param {string} key
     * @param {string} value
     * @returns {void}
     */
    function writeStorageValue(key, value) {
        try {
            if (typeof localStorage === 'undefined' || !localStorage) return;
            localStorage.setItem(key, value);
        } catch (_) {
            // Settings writes are best effort; blocked storage must not break rendering.
        }
    }

    /**
     * Read settings with defensive defaults.
     *
     * Phase 3 only exposes built-in profiles, so unknown profile ids are
     * ignored. Numeric settings are clamped to prevent corrupt storage from
     * affecting grouping/rendering later.
     *
     * @returns {object}
     */
    function readSettings() {
        const settings = Object.assign({}, DEFAULT_SETTINGS);
        const profile = readMultipadProfile();
        settings.profileId = profile.id;
        settings.padProfileId = profile.padProfile.id;
        settings.pedalProfileId = profile.pedalProfile.id;
        settings.triggerProfileId = profile.triggerProfile.id;
        const padProfileId = readStorageValue(LS_KEYS.padProfileId);
        if (!readStorageValue(LS_KEYS.profile) && padProfileId && BUILTIN_PAD_PROFILES[padProfileId]) settings.padProfileId = padProfileId;
        const pedalProfileId = readStorageValue(LS_KEYS.pedalProfileId);
        if (pedalProfileId === DEFAULT_PEDAL_PROFILE.id) settings.pedalProfileId = pedalProfileId;
        const triggerProfileId = readStorageValue(LS_KEYS.triggerProfileId);
        if (triggerProfileId === DEFAULT_TRIGGER_PROFILE.id) settings.triggerProfileId = triggerProfileId;

        for (const key of ['showLabels', 'timingColors', 'hitSparks', 'cinematicLighting']) {
            const raw = readStorageValue(LS_KEYS[key]);
            if (raw === '1' || raw === 'true') settings[key] = true;
            else if (raw === '0' || raw === 'false') settings[key] = false;
        }
        const backgroundStyle = readStorageValue(LS_KEYS.backgroundStyle);
        if (BACKGROUND_STYLE_SET.has(backgroundStyle)) {
            settings.backgroundStyle = backgroundStyle;
        } else {
            const legacyBackground = readStorageValue(LS_KEYS.backgroundAmbience);
            if (legacyBackground === '0' || legacyBackground === 'false') settings.backgroundStyle = 'off';
            else if (legacyBackground === '1' || legacyBackground === 'true') settings.backgroundStyle = 'particles';
        }

        const hitGroupWindowMs = readStorageValue(LS_KEYS.hitGroupWindowMs);
        if (hitGroupWindowMs !== null) {
            settings.hitGroupWindowMs = clampNumber(hitGroupWindowMs, 0, 50, DEFAULT_SETTINGS.hitGroupWindowMs);
        }
        const cameraAngle = readStorageValue(LS_KEYS.cameraAngle);
        if (cameraAngle !== null) settings.cameraAngle = clampNumber(cameraAngle, 0, 1, DEFAULT_SETTINGS.cameraAngle);

        const sceneTheme = readStorageValue(LS_KEYS.sceneTheme);
        if (sceneTheme && SCENE_THEMES[sceneTheme]) settings.sceneTheme = sceneTheme;

        const glowStrength = readStorageValue(LS_KEYS.glowStrength);
        if (glowStrength !== null) settings.glowStrength = clampNumber(glowStrength, 0, 1, DEFAULT_SETTINGS.glowStrength);

        const feedbackIntensity = readStorageValue(LS_KEYS.feedbackIntensity);
        if (feedbackIntensity !== null) settings.feedbackIntensity = clampNumber(feedbackIntensity, 0, 1, DEFAULT_SETTINGS.feedbackIntensity);

        const backgroundIntensity = readStorageValue(LS_KEYS.backgroundIntensity);
        if (backgroundIntensity !== null) settings.backgroundIntensity = clampNumber(backgroundIntensity, 0, 1, DEFAULT_SETTINGS.backgroundIntensity);
        return settings;
    }

    /**
     * Persist one setting after applying the same constraints used by
     * `readSettings`.
     *
     * @param {string} key - One of DEFAULT_SETTINGS keys.
     * @param {*} value - Raw UI value.
     * @returns {void}
     */
    function writeSetting(key, value) {
        if (!Object.prototype.hasOwnProperty.call(LS_KEYS, key)) return;
        if (key === 'profile') {
            writeStorageValue(LS_KEYS.profile, typeof value === 'string' ? value : JSON.stringify(value));
            return;
        }
        if (key === 'padProfileId' && !BUILTIN_PAD_PROFILES[value]) return;
        if (key === 'pedalProfileId' && value !== DEFAULT_PEDAL_PROFILE.id) return;
        if (key === 'triggerProfileId' && value !== DEFAULT_TRIGGER_PROFILE.id) return;
        if (key === 'showLabels') {
            writeStorageValue(LS_KEYS[key], value ? '1' : '0');
            settingsVersion++;
            return;
        }
        if (key === 'timingColors' || key === 'hitSparks' || key === 'cinematicLighting') {
            writeStorageValue(LS_KEYS[key], value ? '1' : '0');
            settingsVersion++;
            return;
        }
        if (key === 'hitGroupWindowMs') {
            writeStorageValue(LS_KEYS[key], String(clampNumber(value, 0, 50, DEFAULT_SETTINGS.hitGroupWindowMs)));
            settingsVersion++;
            return;
        }
        if (key === 'cameraAngle' || key === 'glowStrength' || key === 'feedbackIntensity') {
            writeStorageValue(LS_KEYS[key], String(clampNumber(value, 0, 1, DEFAULT_SETTINGS[key])));
            settingsVersion++;
            return;
        }
        if (key === 'backgroundIntensity') {
            writeStorageValue(LS_KEYS[key], String(clampNumber(value, 0, 1, DEFAULT_SETTINGS.backgroundIntensity)));
            settingsVersion++;
            return;
        }
        if (key === 'backgroundStyle') {
            const id = BACKGROUND_STYLE_SET.has(value) ? value : DEFAULT_SETTINGS.backgroundStyle;
            writeStorageValue(LS_KEYS[key], id);
            settingsVersion++;
            return;
        }
        if (key === 'sceneTheme') {
            const id = SCENE_THEMES[value] ? value : DEFAULT_SETTINGS.sceneTheme;
            writeStorageValue(LS_KEYS[key], id);
            settingsVersion++;
            return;
        }
        writeStorageValue(LS_KEYS[key], String(value));
        settingsVersion++;
    }

    // ---------------------------------------------------------------------
    // Multipad Profile Persistence
    // ---------------------------------------------------------------------

    function cloneMultipadProfile(profile) {
        return {
            version: 1,
            id: profile.id,
            name: profile.name,
            padProfile: clonePadProfile(profile.padProfile),
            pedalProfile: clonePedalProfile(profile.pedalProfile),
            triggerProfile: cloneTriggerProfile(profile.triggerProfile),
        };
    }

    /**
     * Pieces already claimed by a pad, pedal, or trigger anywhere in a
     * combined multipad profile - the read-only counterpart to
     * `validateMultipadProfile`'s `sharedAssignedPieces` write-time dedup.
     * Both answer the same "who else has this piece" question; this one is
     * for callers (the settings UI) that want to filter/preview choices
     * against an already-in-memory, already-consistent profile object
     * without re-running full validation, so it's exposed via
     * `multipadH3dGetAssignedPieces` (05-api.js) instead of each caller
     * hand-rolling its own version of this walk.
     *
     * @param {object} profile - A `{padProfile, pedalProfile, triggerProfile}` shape.
     * @param {object} [options]
     * @param {(pad: object) => boolean} [options.skipPad] - Exclude a pad
     *   (e.g. the one currently being edited) from the count.
     * @param {(pedal: object) => boolean} [options.skipPedal]
     * @param {(trigger: object) => boolean} [options.skipTrigger]
     * @returns {Set<string>}
     */
    function collectAssignedPieces(profile, options) {
        const { skipPad, skipPedal, skipTrigger } = options || {};
        const assigned = new Set();
        const pads = (profile && profile.padProfile && profile.padProfile.pads) || [];
        for (const pad of pads) {
            if (skipPad && skipPad(pad)) continue;
            for (const piece of pad.pieces || []) assigned.add(piece);
        }
        const pedals = (profile && profile.pedalProfile && profile.pedalProfile.pedals) || [];
        for (const pedal of pedals) {
            if (skipPedal && skipPedal(pedal)) continue;
            for (const piece of pedal.pieces || []) assigned.add(piece);
        }
        const triggers = (profile && profile.triggerProfile && profile.triggerProfile.triggers) || [];
        for (const trigger of triggers) {
            if (skipTrigger && skipTrigger(trigger)) continue;
            for (const piece of trigger.pieces || []) assigned.add(piece);
        }
        return assigned;
    }

    function validateMultipadProfile(raw) {
        if (!raw || typeof raw !== 'object') return null;
        // One Set shared across all three validators enforces "any piece
        // assigned to at most one target total" across the whole combined
        // profile, not just within each profile type - pad wins over pedal
        // wins over trigger on conflict (silently dropped from the later
        // one, same "drop instead of throw" style as every other duplicate
        // check in this file).
        const sharedAssignedPieces = new Set();
        const padProfile = validatePadProfile(raw.padProfile, sharedAssignedPieces);
        const pedalProfile = validatePedalProfile(raw.pedalProfile, sharedAssignedPieces);
        const triggerProfile = validateTriggerProfile(raw.triggerProfile, sharedAssignedPieces);
        if (!padProfile || !pedalProfile || !triggerProfile) return null;
        return {
            version: 1,
            id: sanitizeProfileId(raw.id, padProfile.id || DEFAULT_PROFILE.id),
            name: sanitizeProfileDisplayText(raw.name, padProfile.name || 'Custom multipad profile'),
            padProfile,
            pedalProfile,
            triggerProfile,
        };
    }

    function profileForPadLayout(layoutId) {
        const pad = clonePadProfile(BUILTIN_PAD_PROFILES[layoutId] || DEFAULT_PAD_PROFILE);
        const raw = {
            version: 1,
            id: pad.id,
            name: pad.name,
            padProfile: pad,
            pedalProfile: clonePedalProfile(DEFAULT_PEDAL_PROFILE),
            triggerProfile: cloneTriggerProfile(DEFAULT_TRIGGER_PROFILE),
        };
        // Route through validateMultipadProfile rather than returning the
        // hand-composed object directly, so this path enforces the same
        // "a piece lives on at most one target" invariant every other
        // profile-construction path does (readMultipadProfile's legacy
        // padProfileId-only branch calls this directly, with no other
        // validation in between). No built-in pad layout currently assigns
        // a pedal-claimed piece, so this is a no-op today - it's here so a
        // future built-in layout that does can't silently produce a
        // profile with one piece live on two surfaces.
        return validateMultipadProfile(raw) || raw;
    }

    function readMultipadProfile() {
        const stored = readStorageValue(LS_KEYS.profile);
        if (stored) {
            try {
                const parsed = validateMultipadProfile(JSON.parse(stored));
                if (parsed) return parsed;
            } catch (_) {
                // Fall through to legacy profile-id storage/default.
            }
        }
        const padProfileId = readStorageValue(LS_KEYS.padProfileId);
        if (padProfileId && BUILTIN_PAD_PROFILES[padProfileId]) {
            return profileForPadLayout(padProfileId);
        }
        return cloneMultipadProfile(DEFAULT_PROFILE);
    }

    function writeMultipadProfile(raw) {
        const profile = validateMultipadProfile(raw);
        if (!profile) return false;
        writeStorageValue(LS_KEYS.profile, JSON.stringify(profile));
        writeStorageValue(LS_KEYS.padProfileId, profile.padProfile.id);
        writeStorageValue(LS_KEYS.pedalProfileId, profile.pedalProfile.id);
        writeStorageValue(LS_KEYS.triggerProfileId, profile.triggerProfile.id);
        settingsVersion++;
        try {
            window.dispatchEvent(new CustomEvent('multipad_h3d:profile', { detail: { profile: cloneMultipadProfile(profile) } }));
        } catch (_) {}
        return true;
    }

    // ---------------------------------------------------------------------
    // Chart Source Selection
    // ---------------------------------------------------------------------

    function hasDrumTabHitStream(drumTab) {
        return !!(drumTab && Array.isArray(drumTab.hits));
    }

    function chartSourceFromBundle(bundle) {
        const drumTab = bundle && bundle.drumTab;
        if (!hasDrumTabHitStream(drumTab)) {
            return {
                type: 'none',
                drumTab: null,
                hitCount: -1,
            };
        }
        return {
            type: 'drumTab',
            drumTab,
            hitCount: drumTab.hits.length,
        };
    }

    function projectionCacheMatchesSource(source, cache) {
        return !!(
            source
            && cache
            && cache.sourceType === source.type
            && cache.drumTab === source.drumTab
            && cache.hitCount === source.hitCount
            && cache.settingsVersion === settingsVersion
        );
    }

    // ---------------------------------------------------------------------
    // Projection Diagnostics
    // ---------------------------------------------------------------------

    function incrementCount(map, key) {
        if (!key) return;
        map[key] = (map[key] || 0) + 1;
    }

    function countMapKeys(map) {
        return map && typeof map === 'object' ? Object.keys(map).length : 0;
    }

    function routePieceCount(routeMap) {
        return routeMap && typeof routeMap === 'object' ? Object.keys(routeMap).length : 0;
    }

    function projectionStats(source, rawHits, padProfile, pedalProfile, triggerProfile, pieceToPad, pieceToPedal, pieceToTrigger) {
        return {
            source,
            rawHits,
            normalizedHits: 0,
            projectedHits: 0,
            invalidHits: 0,
            unknownPieces: Object.create(null),
            unroutedPieces: Object.create(null),
            projectedPieces: Object.create(null),
            profileId: padProfile.id,
            padProfileId: padProfile.id,
            pedalProfileId: pedalProfile.id,
            triggerProfileId: triggerProfile.id,
            routedPadPieces: routePieceCount(pieceToPad),
            routedPedalPieces: routePieceCount(pieceToPedal),
            routedTriggerPieces: routePieceCount(pieceToTrigger),
        };
    }

    // ---------------------------------------------------------------------
    // Piece-To-Surface Routing
    // ---------------------------------------------------------------------

    /**
     * Build piece -> pad routing for a pad profile.
     *
     * The returned route preserves the original piece and separately
     * records the fallback `routedPiece`, so rendering can keep labels/variants
     * honest while sharing a pad for pieces such as open/closed hi-hat.
     *
     * Iterates ALL_PIECES rather than PAD_PIECES so a piece like kick or
     * hh_pedal - now assignable to a pad, not just a pedal - actually gets
     * routed when a profile does exactly that; PAD_PIECES/PIECE_FALLBACKS
     * still only ever cover non-pedal pieces, so this doesn't change
     * fallback behavior for kick/hh_pedal (neither appears as a fallback
     * key or value), only makes their own direct pad assignment work.
     *
     * @param {object} padProfile - Validated or raw pad profile.
     * @returns {object} Map of piece id to { routeType, pad, routedPiece }.
     */
    function buildPieceToPadMap(padProfile) {
        const profile = validatePadProfile(padProfile) || clonePadProfile(DEFAULT_PAD_PROFILE);
        const direct = Object.create(null);
        for (const pad of profile.pads) {
            for (const piece of pad.pieces) {
                direct[piece] = { routeType: 'pad', pad };
            }
        }

        const routed = Object.create(null);
        for (const piece of ALL_PIECES) {
            if (direct[piece]) {
                routed[piece] = Object.assign({ routedPiece: piece }, direct[piece]);
                continue;
            }
            const fallback = profile.fallbacks[piece] || PIECE_FALLBACKS[piece];
            if (fallback && direct[fallback]) {
                routed[piece] = Object.assign({ routedPiece: fallback }, direct[fallback]);
            }
        }
        return routed;
    }

    /**
     * Build piece -> external trigger surface routing for a trigger profile.
     *
     * @param {object} triggerProfile - Validated or raw trigger profile.
     * @returns {object} Map of piece id to trigger descriptor.
     */
    function buildPieceToTriggerMap(triggerProfile) {
        const profile = validateTriggerProfile(triggerProfile) || cloneTriggerProfile(DEFAULT_TRIGGER_PROFILE);
        const routed = Object.create(null);
        for (const trigger of profile.triggers) {
            for (const piece of trigger.pieces) {
                if (!routed[piece]) routed[piece] = trigger;
            }
        }
        return routed;
    }

    /**
     * Build piece -> pedal surface routing for a pedal profile.
     *
     * @param {object} pedalProfile - Validated or raw pedal profile.
     * @returns {object} Map of piece id to pedal descriptor.
     */
    function buildPieceToPedalMap(pedalProfile) {
        const profile = validatePedalProfile(pedalProfile) || clonePedalProfile(DEFAULT_PEDAL_PROFILE);
        const routed = Object.create(null);
        for (const pedal of profile.pedals) {
            for (const piece of pedal.pieces) {
                if (!routed[piece]) routed[piece] = pedal;
            }
        }
        return routed;
    }

    // ---------------------------------------------------------------------
    // Drum Hit Projection
    // ---------------------------------------------------------------------

    /**
     * Multipad intentionally ignores drum articulations/cues for MVP visuals.
     * The source piece still routes normally, but every scheduled event renders
     * as a plain hit on the corresponding pad or outline surface.
     *
     * @returns {'normal'}
     */
    function hitVariant(hit) {
        void hit;
        return 'normal';
    }

    /**
     * Normalize one `bundle.drumTab.hits[]` entry.
     *
     * Invalid or unknown future pieces return null. Velocity is clamped, and
     * open hi-hat remains a distinct piece even if it later routes to the same
     * pad, trigger, or fallback route as closed hi-hat.
     *
     * @param {*} hit - Raw drum-tab hit.
     * @returns {object|null}
     */
    function normalizeHit(hit) {
        if (!hit || typeof hit !== 'object') return null;
        const t = Number(hit.t);
        const piece = hit.p;
        if (!Number.isFinite(t) || typeof piece !== 'string' || !PIECE_SET.has(piece)) return null;
        const velocity = Math.round(clampNumber(hit.v, 0, 127, 100));
        return {
            t,
            piece,
            velocity,
            ghost: !!hit.g,
            flam: !!hit.f,
            variant: hitVariant({ p: piece, v: velocity, g: !!hit.g, f: !!hit.f }),
            open: piece === 'hh_open',
            timingStatus: normalizeTimingStatus(hit.timingStatus || hit.timing || hit.ts),
        };
    }

    /**
     * Group hit events that occur in the same timing window.
     *
     * A hit group can include multiple pads, external triggers, and pedal
     * surfaces. Hit events are annotated with `hitGroupId` for render-time FX.
     *
     * @param {Array<object>} hitEvents - Projected hit events.
     * @param {number} windowSec - Same-time tolerance in seconds.
     * @returns {Array<object>}
     */
    function groupHitEvents(hitEvents, windowSec) {
        const sorted = hitEvents.slice().sort((a, b) => a.t - b.t || a.piece.localeCompare(b.piece));
        const groups = [];
        const tolerance = Math.max(0, Number(windowSec) || 0);
        for (const hitEvent of sorted) {
            let group = groups.length ? groups[groups.length - 1] : null;
            if (!group || Math.abs(hitEvent.t - group.t) > tolerance) {
                group = {
                    id: groups.length,
                    t: hitEvent.t,
                    hitEvents: [],
                    padIds: [],
                    triggerIds: [],
                    triggerSurfaces: [],
                    pedalSurfaces: [],
                    hasKick: false,
                    hasHiHatPedal: false,
                };
                groups.push(group);
            }
            hitEvent.hitGroupId = group.id;
            group.hitEvents.push(hitEvent);
            if (hitEvent.type === 'pedal') {
                if (hitEvent.piece === 'kick') group.hasKick = true;
                if (hitEvent.piece === 'hh_pedal') group.hasHiHatPedal = true;
                if (hitEvent.surfaceId && !group.pedalSurfaces.includes(hitEvent.surfaceId)) {
                    group.pedalSurfaces.push(hitEvent.surfaceId);
                }
            }
            if (hitEvent.type === 'pad' && !group.padIds.includes(hitEvent.padId)) {
                group.padIds.push(hitEvent.padId);
            }
            if (hitEvent.type === 'trigger' && !group.triggerIds.includes(hitEvent.triggerId)) {
                group.triggerIds.push(hitEvent.triggerId);
            }
            if (hitEvent.type === 'trigger' && hitEvent.surfaceId && !group.triggerSurfaces.includes(hitEvent.surfaceId)) {
                group.triggerSurfaces.push(hitEvent.surfaceId);
            }
        }
        // A hit event counts as a repeat of the immediately previous group
        // when its own surface was also present in that previous group -
        // per surface, not per whole-group composition. A steady repeating
        // hi-hat stays marked "repeat" even the moment another piece (e.g. a
        // snare) joins it or drops back out alongside it, since the hi-hat's
        // own surface is what's being asked about, not whether every other
        // surface in the group also happened to match. (An earlier revision
        // required the *whole* surface set to match exactly, so any change
        // to the group's composition reset every member to "not repeat" -
        // that read as over-eager: a joining/leaving second piece shouldn't
        // interrupt an otherwise-continuing pattern on the first piece.)
        //
        // This is also why there's no separate pad-only variant of this flag
        // for the layout-preview outline to gate on: pad surface ids
        // (`pad:<id>`) are never shared with pedal/trigger surface ids, so
        // for a pad-type event, "was my surface in the previous group's full
        // surface set" and "...in the previous group's pad-only subset" are
        // the same question with the same answer. A per-surface check
        // doesn't need pedal-blindness the way the old whole-set check did -
        // a pedal joining/leaving never touched a pad's own membership check
        // in the first place.
        let previousSurfaces = new Set();
        for (const group of groups) {
            const currentSurfaces = new Set();
            for (const hitEvent of group.hitEvents) {
                if (!hitEvent.surfaceId) continue;
                hitEvent.repeatedFromPreviousGroup = previousSurfaces.has(hitEvent.surfaceId);
                currentSurfaces.add(hitEvent.surfaceId);
            }
            previousSurfaces = currentSurfaces;
        }
        return groups;
    }

    /**
     * Project a drum tab into multipad hit events.
     *
     * This is the Phase 3 bridge from host chart data to renderer-ready data:
     * hits become pad, external-trigger, or pedal surface events, sorted by
     * time and grouped for simultaneous-hit FX. It does no DOM/WebGL work.
     *
     * @param {object} drumTab - Bundle drum tab object with a `hits` array.
     * @param {object} [options]
     * @param {object} [options.padProfile] - Optional pad profile.
     * @param {object} [options.pedalProfile] - Optional pedal profile.
     * @param {object} [options.triggerProfile] - Optional external trigger profile.
     * @param {number} [options.hitGroupWindowSec] - Grouping tolerance.
     * @param {string} [options.source] - Data source label for diagnostics.
     * @returns {{padProfile: object, pedalProfile: object, triggerProfile: object, hitEvents: Array<object>, hitGroups: Array<object>, stats: object}}
     */
    function projectDrumTab(drumTab, options) {
        const opts = options && typeof options === 'object' ? options : {};
        const padProfile = validatePadProfile(opts.padProfile) || clonePadProfile(DEFAULT_PAD_PROFILE);
        const pedalProfile = validatePedalProfile(opts.pedalProfile) || clonePedalProfile(DEFAULT_PEDAL_PROFILE);
        const triggerProfile = validateTriggerProfile(opts.triggerProfile) || cloneTriggerProfile(DEFAULT_TRIGGER_PROFILE);
        const pieceToPad = buildPieceToPadMap(padProfile);
        const pieceToPedal = buildPieceToPedalMap(pedalProfile);
        const pieceToTrigger = buildPieceToTriggerMap(triggerProfile);
        const hitGroupWindowSec = clampNumber(
            opts.hitGroupWindowSec,
            0,
            0.05,
            DEFAULT_SETTINGS.hitGroupWindowMs / 1000
        );
        const hits = drumTab && Array.isArray(drumTab.hits) ? drumTab.hits : [];
        const hitEvents = [];
        const stats = projectionStats(
            opts.source || 'drumTab',
            hits.length,
            padProfile,
            pedalProfile,
            triggerProfile,
            pieceToPad,
            pieceToPedal,
            pieceToTrigger
        );
        function recordEvent(event) {
            hitEvents.push(event);
            stats.projectedHits++;
            incrementCount(stats.projectedPieces, event.piece);
        }

        for (const rawHit of hits) {
            const hit = normalizeHit(rawHit);
            if (!hit) {
                const piece = rawHit && rawHit.p;
                if (typeof piece === 'string' && piece && !PIECE_SET.has(piece)) {
                    incrementCount(stats.unknownPieces, piece);
                } else {
                    stats.invalidHits++;
                }
                continue;
            }
            stats.normalizedHits++;
            const pedal = pieceToPedal[hit.piece];
            if (pedal) {
                recordEvent({
                    type: 'pedal',
                    pedalId: pedal.id,
                    surfaceId: pedal.surface,
                    label: PIECE_LABELS[hit.piece] || pedal.label,
                    pedalLabel: pedal.label,
                    color: pedal.color,
                    t: hit.t,
                    piece: hit.piece,
                    routedPiece: hit.piece,
                    velocity: hit.velocity,
                    variant: hit.variant,
                    open: false,
                    timingStatus: hit.timingStatus,
                });
                continue;
            }
            const trigger = pieceToTrigger[hit.piece];
            if (trigger) {
                recordEvent({
                    type: 'trigger',
                    triggerId: trigger.id,
                    surfaceId: trigger.surface,
                    label: PIECE_LABELS[hit.piece] || trigger.label,
                    triggerLabel: trigger.label,
                    color: trigger.color,
                    t: hit.t,
                    piece: hit.piece,
                    routedPiece: hit.piece,
                    velocity: hit.velocity,
                    variant: hit.variant,
                    open: hit.open,
                    timingStatus: hit.timingStatus,
                });
                continue;
            }
            const route = pieceToPad[hit.piece];
            if (!route) {
                incrementCount(stats.unroutedPieces, hit.piece);
                continue;
            }
            recordEvent({
                type: 'pad',
                padId: route.pad.id,
                surfaceId: 'pad:' + route.pad.id,
                row: route.pad.row,
                col: route.pad.col,
                label: PIECE_LABELS[hit.piece] || route.pad.label,
                padLabel: route.pad.label,
                t: hit.t,
                piece: hit.piece,
                routedPiece: route.routedPiece,
                velocity: hit.velocity,
                variant: hit.variant,
                open: hit.open,
                timingStatus: hit.timingStatus,
            });
        }

        hitEvents.sort((a, b) => a.t - b.t || a.piece.localeCompare(b.piece));
        const hitGroups = groupHitEvents(hitEvents, hitGroupWindowSec);
        return {
            padProfile,
            pedalProfile,
            triggerProfile,
            hitEvents,
            hitGroups,
            stats,
        };
    }

    /**
     * Auto-mode predicate for the visualization picker.
     *
     * Multipad Highway is a standalone, opt-in drum visualization. When it is
     * installed, Auto mode may choose it for drum/percussion charts even if the
     * standard drum highway is also available. It still must not claim guitar,
     * bass, combo, or keys arrangements from full-band packs.
     *
     * @param {object} songInfo - Host song/arrangement metadata.
     * @returns {boolean}
     */
    function matchesArrangement(songInfo) {
        if (!songInfo || !songInfo.has_drum_tab) return false;
        const arr = songInfo.arrangement || songInfo.arrangement_smart_name || '';
        return /\b(?:drums?|percussion)\b/i.test(arr);
    }

    // ---------------------------------------------------------------------
    // Three.js Renderer
    // ---------------------------------------------------------------------

    /**
     * Project a point at a fixed local offset from the pad grid's own
     * center into tunnel/world space at a given travel progress.
     *
     * The grid's own center converges from a compressed point near
     * `TUNNEL_BACK_X_OFFSET`/`TUNNEL_BACK_LIFT` (progress=0, still far
     * away) to its real position (progress=1, at the target plane).
     * `localOffsetX`/`localOffsetY` - a fixed offset from that center, e.g.
     * a pad's own position within the grid - is added UNSCALED at every
     * progress value, rather than being separately compressed toward the
     * vanishing point on its own.
     *
     * This is the single source of truth: both note gems (`placeNote`) and
     * the whole-hit-group outline (`placeLayoutPreview`) call this same
     * function for their own offset (a pad's own `(surface.x, surface.y -
     * GRID_CENTER_Y)`, or `(0, 0)` for the outline's own center) rather
     * than each hand-rolling its own version of this formula. Letting the
     * two drift apart is exactly what caused three separate bugs across
     * this file's history: gems and the outline growing along different
     * size curves, gem size compounding differently than gem spacing under
     * camera perspective, and (most recently) gem position compressing
     * toward its own point while the outline's did not - putting a
     * just-spawned gem near the *center* of an already-correctly-shaped
     * outline instead of at its real proportional spot within it. With one
     * shared formula, that class of divergence is no longer something to
     * remember to keep in sync - there is nothing else it could drift from.
     *
     * @param {number} localOffsetX - Fixed X offset from the grid's own center.
     * @param {number} localOffsetY - Fixed Y offset from the grid's own center.
     * @param {number} progress - Travel progress; 0 = just spawned (far
     *   away, compressed toward the vanishing point), 1 = at the target plane.
     * @returns {{x: number, y: number}} World-space position.
     */
    function projectGridPoint(localOffsetX, localOffsetY, progress) {
        const centerX = TUNNEL_BACK_X_OFFSET * (1 - progress);
        const centerY = GRID_CENTER_Y + TUNNEL_BACK_LIFT * (1 - progress);
        return { x: centerX + localOffsetX, y: centerY + localOffsetY };
    }

    /**
     * Project a rectangle's 4 corners into world space at a given travel
     * progress, via projectGridPoint - the same single-source-of-truth
     * formula every other on-grid position (note gems, the layout-preview
     * outline, the tunnel guide lines) already goes through. Centralizes
     * "corner = center point +/- half width/height, unscaled" so a second
     * caller never has to re-derive it independently (see addTunnelLines'
     * history: its front/back corners used to each hand-roll this).
     *
     * @param {number} x - Surface center X (same convention as surface.x).
     * @param {number} y - Surface center Y (same convention as surface.y,
     *   i.e. NOT yet offset from GRID_CENTER_Y - that conversion happens here).
     * @param {number} w - Rect width.
     * @param {number} h - Rect height.
     * @param {number} progress - Travel progress passed through to projectGridPoint.
     * @param {number} z - World-space Z shared by all 4 returned corners.
     * @returns {Array<[number, number, number]>} Corners in TL, TR, BR, BL order.
     */
    function projectRectCorners(x, y, w, h, progress, z) {
        const localOffsetY = y - GRID_CENTER_Y;
        return [
            [-w / 2, -h / 2],
            [w / 2, -h / 2],
            [w / 2, h / 2],
            [-w / 2, h / 2],
        ].map(([dx, dy]) => {
            const p = projectGridPoint(x + dx, localOffsetY + dy, progress);
            return [p.x, p.y, z];
        });
    }

    /**
     * Opacity of a note gem some time after it has crossed its target
     * threshold. Ramps linearly from `baseOpacity` (whatever opacity the
     * gem had the instant before crossing) down to 0 (fully invisible) over
     * NOTE_PAST_THRESHOLD_FADE_SEC seconds, then stays at 0. Color is not
     * handled here - placeNote snaps color to NOTE_PAST_THRESHOLD_COLOR
     * instantly, independent of this fade.
     *
     * @param {number} baseOpacity - Opacity immediately before crossing.
     * @param {number} secSinceCrossing - Seconds elapsed since the note's dt
     *   crossed 0 (i.e. `-dt`); expected >= 0.
     * @returns {number} Opacity in [0, baseOpacity].
     */
    function pastThresholdOpacity(baseOpacity, secSinceCrossing) {
        const fadeOutFactor = Math.max(0, 1 - secSinceCrossing / NOTE_PAST_THRESHOLD_FADE_SEC);
        return baseOpacity * fadeOutFactor;
    }

    /**
     * Build one renderer instance for the host setRenderer lifecycle.
     *
     * The renderer keeps all Three.js state instance-local. Stable
     * pad/tunnel geometry, shared note materials, and pooled note meshes live
     * until teardown.
     *
     * @returns {{contextType: string, init: Function, draw: Function, resize: Function, destroy: Function}}
     */
    function createFactory() {
        let canvas = null;
        let lastBundle = null;
        let lastWidth = 0;
        let lastHeight = 0;
        let renderScale = 1;
        let destroyed = false;
        let generation = 0;
        let ready = false;
        let scene = null;
        let camera = null;
        let renderer = null;
        let highwayGroup = null;
        let surfaceGroup = null;
        let notesGroup = null;
        let labelGroup = null;
        let surfaces = Object.create(null);
        let noteGeometry = null;
        let noteFaceGeometry = null;
        let noteMaterials = new Map();
        let noteMeshPool = [];
        let tunnelLinesMesh = null;
        let layoutPreviewGroup = null;
        let layoutPreviewGroupFrameGeometry = null;
        let layoutPreviewGroupMaterial = null;
        let layoutPreviewGroupMeshPool = [];
        let visibleLayoutPreviewGroupCount = 0;
        let cachedDrumTab = null;
        let cachedDrumHitCount = -1;
        let cachedProjectionSource = '';
        let cachedProjection = null;
        let cachedSettingsVersion = -1;
        let lastProjectionStats = null;
        let lastZeroProjectionWarningKey = '';
        let activeSurfaceLayoutKey = null;
        let renderCursorProjection = null;
        let renderCursorIndex = 0;
        let renderCursorTime = -Infinity;
        let activeNoteAheadSec = NOTE_AHEAD_FALLBACK_SEC;
        let activeNoteSpawnDepth = NOTE_AHEAD_FALLBACK_SEC * NOTE_SPEED;
        let visibleNoteCount = 0;
        let activeSettings = readSettings();
        let activeThemeId = activeSettings.sceneTheme;
        let floorMesh = null;
        let ambientLight = null;
        let keyLight = null;
        let bgGroup = null;
        let bgState = null;
        let activeBackgroundKey = '';
        let crossedEventFxKeys = new Set();
        let crossingFxProjection = null;
        let crossingFxTime = -Infinity;
        let sparkPoints = null;
        let sparkPos = null;
        let sparkCol = null;
        let sparkVel = null;
        let sparkLife = null;
        let fxLastWall = 0;
        let kickPulse = 0;
        let baseCameraY = 0;

        /**
         * Dispose a Three.js material and its texture map once.
         *
         * @param {object|null} mat - Material-like object to dispose.
         * @param {Set<object>} disposed - Materials already disposed in this pass.
         * @returns {void}
         */
        function disposeMaterial(mat, disposed) {
            if (!mat || disposed.has(mat)) return;
            disposed.add(mat);
            if (mat.map && typeof mat.map.dispose === 'function') mat.map.dispose();
            if (typeof mat.dispose === 'function') mat.dispose();
        }

        /**
         * Dispose every cached note template material (and its gradient
         * texture, via `disposeMaterial`) and reset the cache.
         *
         * These templates are only ever `.clone()`d onto pooled note meshes -
         * the templates themselves never enter the scene graph, so
         * `disposeObjectTree(scene)` never reaches them. Callers that drop
         * `noteMaterials` (settings changes that invalidate cached materials,
         * and teardown) must go through this instead of reassigning
         * `noteMaterials = new Map()` directly, or the old templates and
         * their canvas gradient textures leak silently.
         *
         * @returns {void}
         */
        function disposeNoteMaterials() {
            const disposed = new Set();
            for (const mat of noteMaterials.values()) disposeMaterial(mat, disposed);
            noteMaterials = new Map();
        }

        /**
         * Dispose geometries, materials, and texture maps in an object tree.
         *
         * @param {object|null} root - Three.js object with `traverse`.
         * @returns {void}
         */
        function disposeObjectTree(root) {
            if (!root) return;
            const disposedMaterials = new Set();
            const disposedGeometry = new Set();
            root.traverse(obj => {
                const isSprite = !!(obj && (obj.isSprite || (T && T.Sprite && obj instanceof T.Sprite)));
                if (!isSprite && obj.geometry && !disposedGeometry.has(obj.geometry)) {
                    disposedGeometry.add(obj.geometry);
                    obj.geometry.dispose();
                }
                if (Array.isArray(obj.material)) {
                    for (const mat of obj.material) disposeMaterial(mat, disposedMaterials);
                } else {
                    disposeMaterial(obj.material, disposedMaterials);
                }
            });
        }

        /**
         * Remove an object from whichever parent currently owns it.
         *
         * @param {object|null} obj - Three.js object.
         * @returns {void}
         */
        function removeFromParent(obj) {
            if (obj && obj.parent && typeof obj.parent.remove === 'function') {
                obj.parent.remove(obj);
            }
        }

        /**
         * Apply the shared highway transform used by surfaces, lane guides, and notes.
         *
         * @returns {void}
         */
        function applyHighwayTransform() {
            if (!highwayGroup) return;
            highwayGroup.position.set(0, HIGHWAY_Y_OFFSET, HIGHWAY_Z_OFFSET);
            highwayGroup.rotation.set(HIGHWAY_PITCH, 0, 0);
        }

        /**
         * Hide pooled note groups before rendering the next frame.
         *
         * Stable geometry and materials are shared and disposed during teardown,
         * so note groups can be dropped without disposing those resources here.
         *
         * @returns {void}
         */
        function clearTransientNotes() {
            if (!notesGroup) return;
            for (const entry of noteMeshPool) {
                entry.group.visible = false;
            }
            visibleNoteCount = 0;
        }

        /**
         * Return a reusable note group for this frame.
         *
         * @param {object} material - Body material for the current note variant.
         * @param {object} faceMaterial - Front-face material for the current note variant.
         * @returns {object} Note pool entry.
         */
        function acquireNoteMesh(material, faceMaterial) {
            let entry = noteMeshPool[visibleNoteCount];
            if (!entry) {
                const group = new T.Group();
                const body = new T.Mesh(noteGeometry, material.clone());
                const face = new T.Mesh(noteFaceGeometry, faceMaterial.clone());
                body.position.z = NOTE_GEM_BODY_Z_OFFSET;
                face.position.z = NOTE_GEM_FACE_Z_OFFSET;
                body.renderOrder = 10;
                face.renderOrder = 10;
                body.userData.sourceMaterial = material;
                face.userData.sourceMaterial = faceMaterial;
                group.add(body, face);
                entry = { group, body, face };
                noteMeshPool.push(entry);
                notesGroup.add(group);
            } else {
                if (entry.body.userData.sourceMaterial !== material) {
                    entry.body.material.copy(material);
                    entry.body.userData.sourceMaterial = material;
                }
                if (entry.face.userData.sourceMaterial !== faceMaterial) {
                    entry.face.material.copy(faceMaterial);
                    entry.face.userData.sourceMaterial = faceMaterial;
                }
            }
            entry.group.visible = true;
            visibleNoteCount++;
            return entry;
        }

        /**
         * Hide pooled layout-preview meshes before rendering the next frame.
         *
         * @returns {void}
         */
        function clearTransientLayoutPreviews() {
            if (!layoutPreviewGroup) return;
            for (const entry of layoutPreviewGroupMeshPool) {
                entry.mesh.visible = false;
            }
            visibleLayoutPreviewGroupCount = 0;
        }

        /**
         * Return the shared material for the whole-hit-group outer outline.
         *
         * WebGL ignores `LineBasicMaterial.linewidth` on most platforms (it's
         * clamped to 1px regardless of the value set), so this is drawn as a
         * thin filled frame shape instead of a stroked line - see
         * `buildLayoutPreviewGroupFrameGeometry`.
         *
         * @returns {object} Three.js material.
         */
        function getLayoutPreviewGroupMaterial() {
            if (!layoutPreviewGroupMaterial) {
                layoutPreviewGroupMaterial = new T.MeshBasicMaterial({
                    color: 0xffffff,
                    transparent: true,
                    opacity: LAYOUT_PREVIEW_GROUP_OPACITY,
                    depthWrite: false,
                    side: T.DoubleSide,
                });
            }
            return layoutPreviewGroupMaterial;
        }

        /**
         * Return a reusable whole-hit-group outer outline for this frame.
         *
         * @returns {object} Layout-preview pool entry.
         */
        function acquireLayoutPreviewGroupMesh() {
            const material = getLayoutPreviewGroupMaterial();
            let entry = layoutPreviewGroupMeshPool[visibleLayoutPreviewGroupCount];
            if (!entry) {
                const mesh = new T.Mesh(layoutPreviewGroupFrameGeometry, material.clone());
                // Share note gems' own renderOrder (body/face use 10) rather
                // than a fixed lower value. Three.js only sorts transparent
                // objects by camera distance *within* the same renderOrder -
                // across different renderOrders it draws strictly in
                // renderOrder sequence regardless of depth. A fixed lower
                // renderOrder here meant every outline drew before every
                // gem, so a nearer hit group's outline could get painted
                // over by a farther, still-approaching hit group's gem
                // (drawn later, but at greater camera distance) instead of
                // correctly occluding it. Sharing renderOrder lets Three.js
                // sort outlines and gems together by true distance.
                mesh.renderOrder = 10;
                mesh.userData.sourceGeometry = layoutPreviewGroupFrameGeometry;
                entry = { mesh };
                layoutPreviewGroupMeshPool.push(entry);
                layoutPreviewGroup.add(mesh);
            } else if (entry.mesh.userData.sourceGeometry !== layoutPreviewGroupFrameGeometry) {
                // Cached geometry is shared, not cloned - swap the reference
                // only, never dispose here (buildSurfaceGrid and teardown
                // own disposing it).
                entry.mesh.geometry = layoutPreviewGroupFrameGeometry;
                entry.mesh.userData.sourceGeometry = layoutPreviewGroupFrameGeometry;
            }
            entry.mesh.visible = true;
            visibleLayoutPreviewGroupCount++;
            return entry;
        }

        /**
         * Create a rounded rectangle shape centered on the local origin.
         *
         * @param {number} w - Width.
         * @param {number} h - Height.
         * @param {number} radius - Corner radius.
         * @returns {object} Three.js Shape.
         */
        function makeRoundedRectShape(w, h, radius) {
            return makeRoundedRectShapeAt(0, 0, w, h, radius);
        }

        /**
         * Create a rounded rectangle shape centered on an arbitrary point.
         *
         * @param {number} cx - Center X.
         * @param {number} cy - Center Y.
         * @param {number} w - Width.
         * @param {number} h - Height.
         * @param {number} radius - Corner radius.
         * @returns {object} Three.js Shape.
         */
        function makeRoundedRectShapeAt(cx, cy, w, h, radius) {
            const hw = w / 2;
            const hh = h / 2;
            const r = Math.max(0, Math.min(radius, hw, hh));
            const shape = new T.Shape();
            shape.moveTo(cx - hw + r, cy - hh);
            shape.lineTo(cx + hw - r, cy - hh);
            shape.quadraticCurveTo(cx + hw, cy - hh, cx + hw, cy - hh + r);
            shape.lineTo(cx + hw, cy + hh - r);
            shape.quadraticCurveTo(cx + hw, cy + hh, cx + hw - r, cy + hh);
            shape.lineTo(cx - hw + r, cy + hh);
            shape.quadraticCurveTo(cx - hw, cy + hh, cx - hw, cy + hh - r);
            shape.lineTo(cx - hw, cy - hh + r);
            shape.quadraticCurveTo(cx - hw, cy - hh, cx - hw + r, cy - hh);
            return shape;
        }

        /**
         * Build a thin rectangular frame (border-only, hollow center) shape
         * geometry: an outer rounded rect with a smaller rounded rect cut out
         * as a hole, leaving just a `thickness`-wide ring. Filled geometry
         * gives reliable, controllable thickness - WebGL clamps
         * `LineBasicMaterial.linewidth` to 1px on most platforms, so a
         * stroked `Line` can't be made visibly thicker.
         *
         * @param {number} w - Outer width.
         * @param {number} h - Outer height.
         * @param {number} thickness - Frame thickness in the same units as w/h.
         * @param {number} radius - Outer corner radius, in the same units as w/h.
         * @returns {object} Three.js ShapeGeometry.
         */
        function buildFrameGeometry(w, h, thickness, radius) {
            const shape = makeRoundedRectShape(w, h, radius);
            const innerW = Math.max(0.001, w - thickness * 2);
            const innerH = Math.max(0.001, h - thickness * 2);
            const innerRadius = Math.max(0, radius - thickness);
            shape.holes.push(makeRoundedRectShape(innerW, innerH, innerRadius));
            return new T.ShapeGeometry(shape, NOTE_GEM_CURVE_SEGMENTS);
        }

        /**
         * Build the whole-hit-group outer outline frame geometry, spanning
         * the current pad grid's full bounding box plus a small margin so
         * the frame doesn't touch the outermost gems. Rebuilt whenever the
         * pad profile changes (grid dimensions can change).
         *
         * @param {number} gridW - Grid bounding box width.
         * @param {number} gridH - Grid bounding box height.
         * @returns {object} Three.js ShapeGeometry.
         */
        function buildLayoutPreviewGroupFrameGeometry(gridW, gridH) {
            return buildFrameGeometry(
                gridW + LAYOUT_PREVIEW_GROUP_MARGIN * 2,
                gridH + LAYOUT_PREVIEW_GROUP_MARGIN * 2,
                0.07,
                LAYOUT_PREVIEW_GROUP_CORNER_RADIUS
            );
        }

        /**
         * Create the shared rounded-rectangle geometry for incoming note gems.
         *
         * @returns {object} Three.js geometry centered on the local origin.
         */
        function makeRoundedNoteGeometry() {
            const shape = makeRoundedRectShape(1, 1, NOTE_GEM_CORNER_RADIUS);
            const geo = new T.ExtrudeGeometry(shape, {
                depth: NOTE_GEM_DEPTH,
                bevelEnabled: false,
                curveSegments: NOTE_GEM_CURVE_SEGMENTS,
            });
            geo.translate(0, 0, -NOTE_GEM_DEPTH / 2);
            return geo;
        }

        /**
         * Create the shared rounded front face for incoming note gems.
         *
         * Explicit UVs make the note gradient predictable across browsers and
         * independent of ExtrudeGeometry side/front UV generation.
         *
         * @returns {object} Three.js shape geometry centered on the local origin.
         */
        function makeRoundedNoteFaceGeometry() {
            const geo = new T.ShapeGeometry(makeRoundedRectShape(1, 1, NOTE_GEM_CORNER_RADIUS), NOTE_GEM_CURVE_SEGMENTS);
            const pos = geo.attributes.position;
            const uv = [];
            for (let i = 0; i < pos.count; i++) {
                uv.push(pos.getX(i) + 0.5, pos.getY(i) + 0.5);
            }
            geo.setAttribute('uv', new T.Float32BufferAttribute(uv, 2));
            return geo;
        }

        /**
         * Create a flat rounded rectangle surface geometry.
         *
         * @param {number} w - Width.
         * @param {number} h - Height.
         * @returns {object} Three.js geometry.
         */
        function makeRoundedSurfaceGeometry(w, h) {
            const r = Math.min(w, h) * NOTE_GEM_CORNER_RADIUS;
            return new T.ShapeGeometry(makeRoundedRectShape(w, h, r), NOTE_GEM_CURVE_SEGMENTS);
        }

        /**
         * Create a rounded rectangle outline geometry.
         *
         * @param {number} w - Width.
         * @param {number} h - Height.
         * @returns {object} Three.js geometry.
         */
        function makeRoundedSurfaceEdgeGeometry(w, h) {
            const r = Math.min(w, h) * NOTE_GEM_CORNER_RADIUS;
            const points = makeRoundedRectShape(w, h, r).getPoints(NOTE_GEM_CURVE_SEGMENTS);
            if (points.length) points.push(points[0].clone());
            return new T.BufferGeometry().setFromPoints(points);
        }

        /**
         * Resolve the display color for a projected drum event.
         *
         * @param {object} event - Projected hit event from `projectDrumTab`.
         * @returns {number} Three.js hex color.
         */
        function eventColorForEvent(event) {
            const profileColor = colorHexFromCss(event && event.color);
            if (profileColor !== null) return profileColor;
            return (event && (PIECE_COLORS[event.piece] || PIECE_COLORS[event.routedPiece])) || 0x93c5fd;
        }

        function timingHex(event) {
            if (!activeSettings.timingColors) return TIMING_OK_COLOR;
            const status = normalizeTimingStatus(event && event.timingStatus);
            if (status === 'EARLY') return TIMING_EARLY_COLOR;
            if (status === 'LATE') return TIMING_LATE_COLOR;
            return TIMING_OK_COLOR;
        }

        function sparkBurst(x, y, z, hex, count) {
            if (!activeSettings.hitSparks || !sparkPoints || !sparkLife || count <= 0) return;
            const r = ((hex >> 16) & 255) / 255;
            const g = ((hex >> 8) & 255) / 255;
            const b = (hex & 255) / 255;
            let made = 0;
            for (let i = 0; i < SPARK_COUNT && made < count; i++) {
                if (sparkLife[i] > 0) continue;
                const j = i * 3;
                const ang = Math.random() * Math.PI * 2;
                const sp = 0.12 + Math.random() * 0.28;
                sparkPos[j] = x;
                sparkPos[j + 1] = y;
                sparkPos[j + 2] = z;
                sparkVel[j] = Math.cos(ang) * sp;
                sparkVel[j + 1] = 0.42 + Math.random() * 0.55;
                sparkVel[j + 2] = Math.sin(ang) * sp * 0.55;
                sparkCol[j] = r;
                sparkCol[j + 1] = g;
                sparkCol[j + 2] = b;
                sparkLife[i] = 0.30 + Math.random() * 0.16;
                made++;
            }
        }

        function updateSparks(dt) {
            if (!sparkPoints || !sparkLife) return;
            let any = false;
            const grav = 1.25;
            for (let i = 0; i < SPARK_COUNT; i++) {
                if (sparkLife[i] <= 0) continue;
                const j = i * 3;
                sparkLife[i] -= dt;
                if (sparkLife[i] <= 0) {
                    sparkCol[j] = 0;
                    sparkCol[j + 1] = 0;
                    sparkCol[j + 2] = 0;
                    continue;
                }
                any = true;
                sparkVel[j + 1] -= grav * dt;
                sparkPos[j] += sparkVel[j] * dt;
                sparkPos[j + 1] += sparkVel[j + 1] * dt;
                sparkPos[j + 2] += sparkVel[j + 2] * dt;
                const fade = 1 - Math.min(1, dt * 3.2);
                sparkCol[j] *= fade;
                sparkCol[j + 1] *= fade;
                sparkCol[j + 2] *= fade;
            }
            sparkPoints.geometry.attributes.position.needsUpdate = true;
            sparkPoints.geometry.attributes.color.needsUpdate = true;
            sparkPoints.visible = any;
        }

        function colorComponents(colorHex) {
            return {
                r: (colorHex >> 16) & 255,
                g: (colorHex >> 8) & 255,
                b: colorHex & 255,
            };
        }

        function scaledRgb(rgb, scale) {
            return {
                r: Math.max(0, Math.min(255, Math.round(rgb.r * scale))),
                g: Math.max(0, Math.min(255, Math.round(rgb.g * scale))),
                b: Math.max(0, Math.min(255, Math.round(rgb.b * scale))),
            };
        }

        function rgbCss(rgb) {
            return `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`;
        }

        /**
         * Create a subtle body gradient for note gems.
         *
         * The texture darkens toward local bottom-left so the gem reads as lit
         * from screen top-right without changing the note's source color.
         *
         * @param {number} colorHex - Note color.
         * @returns {object|null} Three.js texture, or null outside the browser.
         */
        function createNoteGradientTexture(colorHex) {
            if (typeof document === 'undefined' || !document.createElement || !T.CanvasTexture) return null;
            const c = document.createElement('canvas');
            c.width = 64;
            c.height = 64;
            const ctx = c.getContext('2d');
            if (!ctx) return null;
            const base = colorComponents(colorHex);
            const dark = scaledRgb(base, 0.26);
            const mid = scaledRgb(base, 0.7);
            const highlight = {
                r: Math.min(255, Math.round(base.r * 1.2 + 30)),
                g: Math.min(255, Math.round(base.g * 1.2 + 30)),
                b: Math.min(255, Math.round(base.b * 1.2 + 30)),
            };
            const grad = ctx.createLinearGradient(0, c.height, c.width, 0);
            grad.addColorStop(0, rgbCss(dark));
            grad.addColorStop(0.58, rgbCss(mid));
            grad.addColorStop(1, rgbCss(highlight));
            ctx.fillStyle = grad;
            ctx.fillRect(0, 0, c.width, c.height);

            const texture = new T.CanvasTexture(c);
            if (T.SRGBColorSpace) texture.colorSpace = T.SRGBColorSpace;
            texture.magFilter = T.LinearFilter;
            texture.minFilter = T.LinearFilter;
            texture.needsUpdate = true;
            return texture;
        }

        /**
         * Return a cached material for note meshes.
         *
         * @param {number} colorHex - Three.js hex color.
         * @param {string} variant - `normal` or `front`.
         * @returns {object} Three.js material.
         */
        function getNoteMaterial(colorHex, variant) {
            const type = variant === 'front' ? variant : 'normal';
            const key = String(colorHex) + ':' + type;
            if (noteMaterials.has(key)) return noteMaterials.get(key);
            const glow = 0.25 + (activeSettings.glowStrength || 0) * 0.75;
            const gradientMap = type === 'front' ? createNoteGradientTexture(colorHex) : null;
            let material;
            if (type === 'front') {
                material = new T.MeshBasicMaterial({
                    color: gradientMap ? 0xffffff : colorHex,
                    map: gradientMap || null,
                    transparent: true,
                    opacity: 0.98,
                    depthWrite: true,
                    side: T.DoubleSide,
                });
            } else {
                material = new T.MeshStandardMaterial({
                    color: colorHex,
                    emissive: colorHex,
                    emissiveIntensity: 0.06 * glow,
                    metalness: 0.12,
                    roughness: 0.5,
                    transparent: true,
                    opacity: 0.82,
                });
            }
            noteMaterials.set(key, material);
            return material;
        }

        function updateSettingsFromStorage() {
            const next = readSettings();
            const noteMaterialChanged = !activeSettings || next.glowStrength !== activeSettings.glowStrength;
            const cinematicChanged = !activeSettings || next.cinematicLighting !== activeSettings.cinematicLighting;
            const backgroundChanged = !activeSettings || next.backgroundStyle !== activeSettings.backgroundStyle || next.backgroundIntensity !== activeSettings.backgroundIntensity;
            // Label sprites are only built when showLabels is on (see
            // buildSurfaceGrid) - skipping the canvas/texture work entirely
            // while labels are off, rather than always building them and
            // only hiding via labelGroup.visible. So flipping the setting
            // off -> on needs to force one real surface-grid rebuild to
            // actually create them: nulling activeSurfaceLayoutKey makes
            // the very next buildSurfaceGrid call (reached via the normal
            // settingsVersion-bump -> projection-cache-miss path every
            // writeSetting call already triggers) miss its own cache check
            // instead of early-returning with no labels built.
            const labelsJustEnabled = !!next.showLabels && !(activeSettings && activeSettings.showLabels);
            if (labelsJustEnabled) activeSurfaceLayoutKey = null;
            activeSettings = next;
            if (labelGroup) labelGroup.visible = !!activeSettings.showLabels;
            if (camera) applyCameraSettings();
            if (cinematicChanged) applyCinematicLighting();
            if (backgroundChanged) buildBackground();
            if (noteMaterialChanged) disposeNoteMaterials();
            if (activeThemeId !== activeSettings.sceneTheme) {
                applySceneTheme();
            }
        }

        function themeColors() {
            return SCENE_THEMES[activeSettings.sceneTheme] || SCENE_THEMES.default;
        }

        function applySceneTheme() {
            if (!scene) return;
            activeThemeId = activeSettings.sceneTheme;
            const theme = themeColors();
            scene.background = new T.Color(theme.clear);
            if (scene.fog) scene.fog.color.setHex(theme.fog);
            if (floorMesh && floorMesh.material && floorMesh.material.color) floorMesh.material.color.setHex(theme.floor);
            if (renderer && renderer.setClearColor) renderer.setClearColor(theme.clear, 1);
            if (surfaceGroup) {
                for (const surface of Object.values(surfaces)) {
                    if (!surface.active) continue;
                    if (TARGET_ZONE_PLANE_KINDS.has(surface.kind) && surface.baseEmissiveColor != null) {
                        applyTargetZoneStyle(surface, surface.baseEmissiveColor);
                        continue;
                    }
                    if (surface.material && surface.material.color && surface.kind !== 'external-trigger-center' && surface.kind !== 'external-trigger-edge' && surface.kind !== 'external-trigger-rim') {
                        surface.material.color.setHex(theme.pad);
                    }
                    if (surface.edgeMaterial && surface.edgeMaterial.color) surface.edgeMaterial.color.setHex(theme.edge);
                }
            }
        }

        function applyCameraSettings() {
            if (!camera) return;
            const a = activeSettings.cameraAngle;
            camera.position.set(CAMERA_PAN_X, GRID_CENTER_Y + CAMERA_PAN_Y + a * 0.35, 6.8 - a * 0.8);
            camera.lookAt(CAMERA_PAN_X, GRID_CENTER_Y + CAMERA_PAN_Y, -TUNNEL_DEPTH * 0.5);
            baseCameraY = camera.position.y;
        }

        /**
         * Create a texture-backed sprite label from one or more lines of
         * text, stacked top-to-bottom and centered as a block. Font size
         * shrinks both as more lines are stacked and per-line when a single
         * line (e.g. a long full piece name like "Snare (cross-stick)")
         * would otherwise overflow the canvas, instead of ever hard-cutting
         * text to a fixed character count.
         *
         * @param {string|Array<string>} lines - Text to render; a bare
         *   string is treated as a single line. Falsy/empty entries are
         *   dropped.
         * @param {number} width - Sprite width in world units.
         * @param {number} height - Sprite height in world units.
         * @returns {object|null} Three.js sprite, or null when canvas is
         *   unavailable or there is no non-empty text to render.
         */
        function createLabelSprite(lines, width, height) {
            if (typeof document === 'undefined' || !document.createElement) return null;
            const items = (Array.isArray(lines) ? lines : [lines]).map(l => String(l || '')).filter(Boolean);
            if (!items.length) return null;
            const c = document.createElement('canvas');
            c.width = 384;
            c.height = 160;
            const ctx = c.getContext('2d');
            if (!ctx) return null;
            ctx.clearRect(0, 0, c.width, c.height);
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.lineWidth = 5;
            ctx.strokeStyle = 'rgba(0, 0, 0, 0.82)';
            ctx.fillStyle = SCENE_COLORS.text;
            const maxTextWidth = c.width - 24;
            const rowHeight = c.height / items.length;
            // Scaled directly off the available row height (not a fixed
            // floor) so a pad/trigger with many stacked pieces keeps
            // shrinking instead of overlapping once row height drops below
            // what a fixed minimum font would need - the per-line
            // width-based shrink loop below still applies on top of this.
            const baseFontPx = Math.max(8, Math.min(34, Math.floor(rowHeight * 0.72)));
            const fontAt = px => `700 ${px}px system-ui, -apple-system, Segoe UI, sans-serif`;
            items.forEach((text, i) => {
                let fontPx = baseFontPx;
                ctx.font = fontAt(fontPx);
                while (fontPx > 11 && ctx.measureText(text).width > maxTextWidth) {
                    fontPx -= 2;
                    ctx.font = fontAt(fontPx);
                }
                const y = rowHeight * i + rowHeight / 2;
                ctx.strokeText(text, c.width / 2, y);
                ctx.fillText(text, c.width / 2, y);
            });
            const texture = new T.CanvasTexture(c);
            const material = new T.SpriteMaterial({
                map: texture,
                transparent: true,
                depthWrite: false,
            });
            const sprite = new T.Sprite(material);
            sprite.scale.set(width, height, 1);
            return sprite;
        }

        /**
         * Reasonable label box (world units) for a non-pad target surface,
         * derived from its own geometry - wide/short rectangles for
         * pedal/trigger outline bars, radius-scaled for circular/ring
         * external trigger zones. Pads use their own fixed, separately
         * tuned PAD_W/PAD_H-based box (see buildSurfaceLabel) since that
         * size was already tuned for the single-line abbreviation label
         * and is kept unchanged for the common case.
         *
         * @param {object} desc - Surface descriptor from buildSurfaceLayout.
         * @returns {{w: number, h: number}}
         */
        function labelBoxForSurface(desc) {
            if (desc.shape === 'circle' || desc.shape === 'ring') {
                const r = desc.radius || desc.w / 2;
                return { w: Math.min(2.2, Math.max(0.5, r * 1.7)), h: Math.min(0.42, Math.max(0.16, r * 0.9)) };
            }
            return { w: Math.min(2.2, Math.max(0.5, desc.w * 0.7)), h: Math.min(0.42, Math.max(0.16, desc.h * 0.6)) };
        }

        /**
         * Build the label sprite for one surface descriptor, if any - full
         * friendly piece names (see PIECE_FRIENDLY_LABELS/friendlyPieceLabel
         * in 01-constants.js), one per line, matching how pieces are shown
         * in the settings panel rather than the short PIECE_LABELS
         * abbreviations that aren't used anywhere else. A pad always gets a
         * label (an em dash placeholder when unassigned, matching the
         * existing "Unassigned" chip convention in settings.html); pedal
         * and trigger surfaces only get one when at least one piece is
         * actually mapped there.
         *
         * @param {object} desc - Surface descriptor from buildSurfaceLayout.
         * @returns {object|null} Three.js sprite, or null.
         */
        function buildSurfaceLabel(desc) {
            const pieces = desc.pieces || [];
            if (desc.kind === 'pad') {
                const lines = pieces.length ? pieces.map(friendlyPieceLabel) : ['—'];
                return createLabelSprite(lines, PAD_W * 0.58, PAD_H * 0.26);
            }
            if (!pieces.length) return null;
            const box = labelBoxForSurface(desc);
            return createLabelSprite(pieces.map(friendlyPieceLabel), box.w, box.h);
        }

        /**
         * Add receding tunnel guide lines behind one pad surface.
         *
         * Corners come from projectRectCorners (front at progress=1, the
         * real position; back at progress=0, the same far/vanishing point
         * note gems spawn from) instead of a hand-rolled formula, so these
         * lines are guaranteed to converge exactly like the note gems
         * traveling through them - a previous version scaled each back
         * corner's offset from center by a fixed TUNNEL_BACK_SCALE, which
         * doesn't match how projectGridPoint (the single source of truth
         * for every other on-grid position) converges, and the lines
         * visibly didn't line up with the gems.
         *
         * @param {number} x - Surface center X.
         * @param {number} y - Surface center Y.
         * @param {number} w - Surface width.
         * @param {number} h - Surface height.
         * @param {object} group - Three.js group receiving the line segments.
         * @returns {void}
         */
        function addTunnelLines(x, y, w, h, group) {
            const front = projectRectCorners(x, y, w, h, 1, 0.015);
            const back = projectRectCorners(x, y, w, h, 0, -TUNNEL_DEPTH);
            const vertices = [];
            for (let i = 0; i < 4; i++) {
                const next = (i + 1) % 4;
                vertices.push(...front[i], ...back[i], ...back[i], ...back[next]);
            }
            const geo = new T.BufferGeometry();
            geo.setAttribute('position', new T.Float32BufferAttribute(vertices, 3));
            const mat = new T.LineBasicMaterial({
                color: SCENE_COLORS.tunnel,
                transparent: true,
                opacity: 0.38,
                depthWrite: false,
            });
            const lines = new T.LineSegments(geo, mat);
            // Keep well below note gems' renderOrder (10/11) and skip
            // writing depth, so these always draw behind incoming notes
            // instead of z-fighting/poking through them.
            lines.renderOrder = 1;
            group.add(lines);
            // Debug-only - read by __probe()'s `tunnelLineVertices` so tests
            // can verify the guide lines' back corners actually match
            // projectGridPoint instead of a hand-rolled formula.
            tunnelLinesMesh = lines;
        }

        /**
         * Add one rectangular render surface and edge outline to the surface group.
         *
         * @param {string} key - Surface id.
         * @param {number} x - Surface center X.
         * @param {number} y - Surface center Y.
         * @param {number} w - Surface width.
         * @param {number} h - Surface height.
         * @param {number} colorHex - Routed surface color.
         * @param {number} opacity - Base material opacity.
         * @param {object} group - Three.js group receiving the surface meshes.
         * @returns {object} Surface descriptor used by note placement.
         */
        function addPlaneSurface(key, x, y, w, h, colorHex, opacity, group) {
            const geo = makeRoundedSurfaceGeometry(w, h);
            const theme = themeColors();
            const mat = new T.MeshStandardMaterial({
                color: theme.pad,
                emissive: colorHex,
                emissiveIntensity: 0.05,
                metalness: 0.1,
                roughness: 0.72,
                side: T.DoubleSide,
                transparent: true,
                depthWrite: false,
                opacity,
            });
            const mesh = new T.Mesh(geo, mat);
            mesh.position.set(x, y, 0);
            group.add(mesh);

            const edgeGeo = makeRoundedSurfaceEdgeGeometry(w, h);
            const edgeMat = new T.LineBasicMaterial({
                color: theme.edge,
                transparent: true,
                opacity: 0.74,
            });
            const edges = new T.Line(edgeGeo, edgeMat);
            edges.position.copy(mesh.position);
            group.add(edges);

            return { key, x, y, w, h, mesh, material: mat, edgeMaterial: edgeMat, baseOpacity: opacity, baseEmissiveIntensity: 0.05 };
        }

        /**
         * Add one circular render surface and circular edge outline.
         *
         * @param {string} key - Surface id.
         * @param {number} x - Surface center X.
         * @param {number} y - Surface center Y.
         * @param {number} radius - Circle radius.
         * @param {number} colorHex - Fill/emissive color for the circle.
         * @param {number} opacity - Base material opacity.
         * @param {object} group - Three.js group receiving the surface meshes.
         * @returns {object} Surface descriptor used by note placement.
         */
        function addCircleSurface(key, x, y, radius, colorHex, opacity, group) {
            const geo = new T.CircleGeometry(radius, 48);
            const mat = new T.MeshStandardMaterial({
                color: colorHex,
                emissive: colorHex,
                emissiveIntensity: 0.12,
                metalness: 0.08,
                roughness: 0.58,
                side: T.DoubleSide,
                transparent: true,
                depthWrite: false,
                opacity,
            });
            const mesh = new T.Mesh(geo, mat);
            mesh.position.set(x, y, 0.018);
            group.add(mesh);

            const points = [];
            for (let i = 0; i <= 48; i++) {
                const theta = (i / 48) * Math.PI * 2;
                points.push(new T.Vector3(Math.cos(theta) * radius, Math.sin(theta) * radius, 0));
            }
            const edgeGeo = new T.BufferGeometry().setFromPoints(points);
            const edgeMat = new T.LineBasicMaterial({
                color: colorHex,
                transparent: true,
                opacity: 0.82,
            });
            const edges = new T.Line(edgeGeo, edgeMat);
            edges.position.copy(mesh.position);
            group.add(edges);

            const diameter = radius * 2;
            return {
                key,
                x,
                y,
                w: diameter,
                h: diameter,
                shape: 'circle',
                radius,
                mesh,
                material: mat,
                edgeMaterial: edgeMat,
                baseOpacity: opacity,
                baseEmissiveColor: colorHex,
                baseEmissiveIntensity: 0.12,
            };
        }

        /**
         * Add one thick ring render surface for external trigger edge/rim zones.
         *
         * @param {string} key - Surface id.
         * @param {number} x - Surface center X.
         * @param {number} y - Surface center Y.
         * @param {number} innerRadius - Inner radius of the ring.
         * @param {number} outerRadius - Outer radius of the ring.
         * @param {number} colorHex - Fill/emissive color for the ring.
         * @param {number} opacity - Base material opacity.
         * @param {object} group - Three.js group receiving the surface mesh.
         * @returns {object} Surface descriptor used by note placement.
         */
        function addRingSurface(key, x, y, innerRadius, outerRadius, colorHex, opacity, group) {
            const geo = new T.RingGeometry(innerRadius, outerRadius, 64);
            const mat = new T.MeshStandardMaterial({
                color: colorHex,
                emissive: colorHex,
                emissiveIntensity: 0.16,
                metalness: 0.08,
                roughness: 0.52,
                side: T.DoubleSide,
                transparent: true,
                depthWrite: false,
                opacity,
            });
            const mesh = new T.Mesh(geo, mat);
            mesh.position.set(x, y, 0.026);
            group.add(mesh);

            const diameter = outerRadius * 2;
            return {
                key,
                x,
                y,
                w: diameter,
                h: diameter,
                shape: 'ring',
                radius: outerRadius,
                mesh,
                material: mat,
                baseOpacity: opacity,
                baseEmissiveColor: colorHex,
                baseEmissiveIntensity: 0.16,
            };
        }

        // Plane-shaped (addPlaneSurface) target-zone kinds that should read
        // as a colored outline with a faint fill once assigned - pads,
        // pedal outline bars, and outline-left/outline-right trigger
        // surfaces. Circle/ring external-trigger zones are deliberately
        // excluded (see TARGET_ZONE_FILL_OPACITY's comment).
        const TARGET_ZONE_PLANE_KINDS = new Set(['pad', 'pedal-outline', 'trigger-outline']);

        /**
         * Make an assigned plane-shaped target zone (pad, pedal outline, or
         * trigger outline) read as a colored outline with a faint fill,
         * instead of the neutral theme-colored fill/edge addPlaneSurface
         * builds by default.
         *
         * @param {object} surface - Surface descriptor returned by addPlaneSurface.
         * @param {number} colorHex - Routed target color.
         * @returns {void}
         */
        function applyTargetZoneStyle(surface, colorHex) {
            if (!surface) return;
            if (surface.material) {
                if (surface.material.color) surface.material.color.setHex(colorHex);
                if (surface.material.emissive) surface.material.emissive.setHex(colorHex);
                surface.material.emissiveIntensity = 0.04;
                surface.material.opacity = TARGET_ZONE_FILL_OPACITY;
            }
            if (surface.edgeMaterial) {
                if (surface.edgeMaterial.color) surface.edgeMaterial.color.setHex(colorHex);
                surface.edgeMaterial.opacity = TARGET_ZONE_EDGE_OPACITY;
            }
            surface.baseOpacity = TARGET_ZONE_FILL_OPACITY;
            surface.baseEmissiveColor = colorHex;
            surface.baseEmissiveIntensity = 0.04;
        }

        /**
         * Rebuild the stable pad grid, labels, tunnels, and outline surfaces.
         *
         * Called on every drum-tab projection cache miss, which includes
         * each streamed hit chunk arriving from the host (see
         * `projectionForBundle`) - not just real profile changes. The
         * layout key depends only on the pad/pedal/trigger profiles, so
         * skip the dispose/rebuild of Three.js geometry, materials, and
         * label sprites when it hasn't actually changed.
         *
         * @param {object} profile - Validated pad profile.
         * @returns {void}
         */
        function buildSurfaceGrid(profile, pedalProfile, triggerProfile) {
            const layout = buildSurfaceLayout(profile, pedalProfile, triggerProfile);
            if (surfaceGroup && layout.layoutKey === activeSurfaceLayoutKey) return;
            if (surfaceGroup) {
                disposeObjectTree(surfaceGroup);
                removeFromParent(surfaceGroup);
            }
            if (labelGroup) {
                disposeObjectTree(labelGroup);
                removeFromParent(labelGroup);
            }
            surfaceGroup = new T.Group();
            labelGroup = new T.Group();
            labelGroup.visible = !!activeSettings.showLabels;
            (highwayGroup || scene).add(surfaceGroup);
            (highwayGroup || scene).add(labelGroup);
            surfaces = Object.create(null);
            activeSurfaceLayoutKey = layout.layoutKey;
            // Pad positions/count may have changed - the cached whole-group
            // outline geometry (see placeLayoutPreview) is stale.
            if (layoutPreviewGroupFrameGeometry) layoutPreviewGroupFrameGeometry.dispose();
            layoutPreviewGroupFrameGeometry = buildLayoutPreviewGroupFrameGeometry(layout.gridW, layout.gridH);
            // One guide-line frustum for the whole grid's bounding box - not
            // one per pad, which cluttered the highway with a line for every
            // single cell.
            addTunnelLines(0, GRID_CENTER_Y, layout.gridW, layout.gridH, surfaceGroup);

            for (const desc of layout.surfaces) {
                let surface;
                if (desc.shape === 'circle') {
                    surface = addCircleSurface(desc.key, desc.x, desc.y, desc.radius, desc.color, desc.opacity, surfaceGroup);
                } else if (desc.shape === 'ring') {
                    surface = addRingSurface(desc.key, desc.x, desc.y, desc.innerRadius, desc.outerRadius, desc.color, desc.opacity, surfaceGroup);
                } else {
                    surface = addPlaneSurface(desc.key, desc.x, desc.y, desc.w, desc.h, desc.color, desc.opacity, surfaceGroup);
                }
                surface.active = !!desc.active;
                if (!surface.active) {
                    if (surface.material && surface.material.color) surface.material.color.setHex(SCENE_COLORS.inactiveSurface);
                    if (surface.material && surface.material.emissive) surface.material.emissive.setHex(SCENE_COLORS.inactiveSurface);
                    if (surface.edgeMaterial && surface.edgeMaterial.color) surface.edgeMaterial.color.setHex(SCENE_COLORS.inactiveEdge);
                    if (surface.edgeMaterial) surface.edgeMaterial.opacity = 0.35;
                } else if (TARGET_ZONE_PLANE_KINDS.has(desc.kind)) {
                    applyTargetZoneStyle(surface, desc.color);
                }
                if (surface.material && surface.material.emissive && typeof surface.material.emissive.getHex === 'function') {
                    surface.baseEmissiveColor = surface.material.emissive.getHex();
                }
                surface.kind = desc.kind;
                surfaces[surface.key] = surface;
                // Skipped entirely (no canvas/texture work) when labels are
                // off, rather than always built and only hidden via
                // labelGroup.visible - updateSettingsFromStorage forces one
                // rebuild when showLabels flips off -> on, so toggling live
                // still works without ever leaving labelGroup empty.
                const label = activeSettings.showLabels ? buildSurfaceLabel(desc) : null;
                if (label) {
                    label.position.set(desc.x, desc.y, 0.08);
                    // Debug-only - read by __probe()'s `labels` so tests can
                    // correlate a label sprite back to the surface it belongs to.
                    label.userData.surfaceKey = desc.key;
                    labelGroup.add(label);
                }
            }
        }

        function buildBackground() {
            if (!scene) return;
            if (bgGroup) {
                disposeObjectTree(bgGroup);
                scene.remove(bgGroup);
            }
            bgGroup = new T.Group();
            bgGroup.renderOrder = -1;
            scene.add(bgGroup);
            bgState = null;
            const style = BACKGROUND_STYLE_SET.has(activeSettings.backgroundStyle) ? activeSettings.backgroundStyle : DEFAULT_SETTINGS.backgroundStyle;
            const intensity = clampNumber(activeSettings.backgroundIntensity, 0, 1, DEFAULT_SETTINGS.backgroundIntensity);
            activeBackgroundKey = style + ':' + intensity;
            if (style === 'off') return;

            if (style === 'particles') {
                const count = Math.max(20, Math.floor(80 + 200 * intensity));
                const positions = new Float32Array(count * 3);
                for (let i = 0; i < count; i++) {
                    positions[i * 3] = (Math.random() - 0.5) * 14;
                    positions[i * 3 + 1] = Math.random() * 5.8 - 0.4;
                    positions[i * 3 + 2] = -12 - Math.random() * 18;
                }
                const geo = new T.BufferGeometry();
                geo.setAttribute('position', new T.BufferAttribute(positions, 3).setUsage(T.DynamicDrawUsage));
                const mat = new T.PointsMaterial({
                    color: 0xa0c0ff,
                    size: 0.035,
                    transparent: true,
                    opacity: 0.58,
                    blending: T.AdditiveBlending,
                    depthWrite: false,
                    sizeAttenuation: true,
                });
                const points = new T.Points(geo, mat);
                points.frustumCulled = false;
                points.renderOrder = -1;
                bgGroup.add(points);
                bgState = { style, points, geo, mat, count };
                return;
            }

            if (style === 'lights') {
                const lights = [];
                const count = Math.floor(6 + 8 * intensity);
                for (let i = 0; i < count; i++) {
                    const geo = new T.PlaneGeometry(0.22, 0.22);
                    const mat = new T.MeshBasicMaterial({
                        color: DEFAULT_PALETTE[i % DEFAULT_PALETTE.length],
                        transparent: true,
                        opacity: 0.55,
                        blending: T.AdditiveBlending,
                        depthWrite: false,
                    });
                    const mesh = new T.Mesh(geo, mat);
                    mesh.renderOrder = -1;
                    mesh.position.set((Math.random() - 0.5) * 11, Math.random() * 4.8 + 0.2, -13 - Math.random() * 17);
                    bgGroup.add(mesh);
                    lights.push({ mesh, geo, mat, baseScale: 1 + Math.random() * 0.5, phase: Math.random() * Math.PI * 2 });
                }
                bgState = { style, lights };
                return;
            }

            if (style === 'geometric') {
                const meshes = [];
                const opacity = 0.45 + 0.25 * intensity;
                const ico = new T.Mesh(
                    new T.IcosahedronGeometry(0.65, 1),
                    new T.MeshBasicMaterial({ color: 0x6080c0, wireframe: true, transparent: true, opacity, depthWrite: false })
                );
                ico.position.set(-3.0, 3.5, -18);
                ico.renderOrder = -1;
                bgGroup.add(ico);
                meshes.push(ico);

                const torus = new T.Mesh(
                    new T.TorusGeometry(0.48, 0.08, 6, 12),
                    new T.MeshBasicMaterial({ color: 0xc06080, wireframe: true, transparent: true, opacity: opacity * 0.9, depthWrite: false })
                );
                torus.position.set(3.2, 2.7, -20);
                torus.renderOrder = -1;
                bgGroup.add(torus);
                meshes.push(torus);
                bgState = { style, meshes };
            }
        }

        function updateBackground(dt, t) {
            const style = BACKGROUND_STYLE_SET.has(activeSettings.backgroundStyle) ? activeSettings.backgroundStyle : DEFAULT_SETTINGS.backgroundStyle;
            const intensity = clampNumber(activeSettings.backgroundIntensity, 0, 1, DEFAULT_SETTINGS.backgroundIntensity);
            const key = style + ':' + intensity;
            if (key !== activeBackgroundKey) buildBackground();
            if (!bgState) return;
            if (bgState.style === 'particles') {
                const positions = bgState.geo.attributes.position.array;
                const dx = dt * 0.10;
                for (let i = 0; i < bgState.count; i++) {
                    positions[i * 3] += dx;
                    if (positions[i * 3] > 7) positions[i * 3] -= 14;
                }
                bgState.geo.attributes.position.needsUpdate = true;
                bgState.mat.opacity = 0.46 + Math.sin(t * 0.75) * 0.08;
            } else if (bgState.style === 'lights') {
                for (const light of bgState.lights) {
                    const pulse = 1 + Math.sin(t * 1.5 + light.phase) * 0.2;
                    light.mesh.scale.set(light.baseScale * pulse, light.baseScale * pulse, 1);
                    light.mat.opacity = 0.55 + Math.sin(t * 1.1 + light.phase) * 0.12;
                }
            } else if (bgState.style === 'geometric') {
                const pulse = 1 + Math.sin(t * 1.2) * 0.08;
                for (const mesh of bgState.meshes) {
                    mesh.rotation.x += dt * 0.06;
                    mesh.rotation.y += dt * 0.08;
                    mesh.scale.setScalar(pulse);
                }
            }
        }

        function applyCinematicLighting() {
            if (ambientLight) ambientLight.intensity = activeSettings.cinematicLighting ? 0.30 : 0.40;
            if (keyLight) keyLight.intensity = activeSettings.cinematicLighting ? 1.20 : 1.00;
        }

        /**
         * Create the base Three.js scene, camera, lights, floor, and surface grid.
         *
         * @returns {void}
         */
        function initScene() {
            scene = new T.Scene();
            activeSettings = readSettings();
            activeThemeId = activeSettings.sceneTheme;
            const theme = themeColors();
            scene.background = new T.Color(theme.clear);
            scene.fog = new T.Fog(theme.fog, 12, 34);
            camera = new T.PerspectiveCamera(54, 1, 0.1, 90);
            applyCameraSettings();

            ambientLight = new T.AmbientLight(0x7c8ca8, 0.40);
            keyLight = new T.DirectionalLight(0xffffff, 1.00);
            keyLight.position.set(-3, 6, 5);
            const rim = new T.DirectionalLight(0x67e8f9, 0.65);
            rim.position.set(3, 3, -6);
            scene.add(ambientLight, keyLight, rim);
            applyCinematicLighting();
            buildBackground();

            floorMesh = new T.Mesh(
                new T.PlaneGeometry(20, 42),
                new T.MeshStandardMaterial({
                    color: theme.floor,
                    roughness: 0.85,
                    metalness: 0.06,
                })
            );
            floorMesh.rotation.x = -Math.PI / 2;
            floorMesh.position.set(0, FLOOR_Y, -9);
            scene.add(floorMesh);

            sparkPos = new Float32Array(SPARK_COUNT * 3);
            sparkCol = new Float32Array(SPARK_COUNT * 3);
            sparkVel = new Float32Array(SPARK_COUNT * 3);
            sparkLife = new Float32Array(SPARK_COUNT);
            const sparkGeo = new T.BufferGeometry();
            sparkGeo.setAttribute('position', new T.BufferAttribute(sparkPos, 3).setUsage(T.DynamicDrawUsage));
            sparkGeo.setAttribute('color', new T.BufferAttribute(sparkCol, 3).setUsage(T.DynamicDrawUsage));
            const sparkMat = new T.PointsMaterial({
                size: 0.035,
                vertexColors: true,
                transparent: true,
                opacity: 0.8,
                depthWrite: false,
                blending: T.AdditiveBlending,
                sizeAttenuation: true,
            });
            sparkPoints = new T.Points(sparkGeo, sparkMat);
            sparkPoints.frustumCulled = false;
            sparkPoints.renderOrder = 8;
            sparkPoints.visible = false;
            scene.add(sparkPoints);

            highwayGroup = new T.Group();
            applyHighwayTransform();
            scene.add(highwayGroup);

            notesGroup = new T.Group();
            highwayGroup.add(notesGroup);
            layoutPreviewGroup = new T.Group();
            highwayGroup.add(layoutPreviewGroup);
            noteGeometry = makeRoundedNoteGeometry();
            noteFaceGeometry = makeRoundedNoteFaceGeometry();
            const profile = readMultipadProfile();
            buildSurfaceGrid(profile.padProfile, profile.pedalProfile, profile.triggerProfile);
        }

        /**
         * Apply canvas size, device pixel ratio, and camera aspect.
         *
         * @param {number} w - CSS width from the host.
         * @param {number} h - CSS height from the host.
         * @returns {void}
         */
        function applySize(w, h) {
            if (!renderer || !camera || !canvas) return;
            const W = Math.max(1, Math.round(w || canvas.clientWidth || canvas.width || 1));
            const H = Math.max(1, Math.round(h || canvas.clientHeight || canvas.height || 1));
            const split = liveInstances.size > 1;
            const baseDpr = split
                ? Math.min(window.devicePixelRatio || 1, 1.25)
                : Math.min(window.devicePixelRatio || 1, 2);
            renderer.setPixelRatio(baseDpr * renderScale);
            renderer.setSize(W, H, false);
            camera.aspect = W / H;
            camera.updateProjectionMatrix();
            lastWidth = W;
            lastHeight = H;
        }

        /**
         * Return projected hit events for the current bundle.
         *
         * The real chart projection is cached by drum-tab object identity and
         * hit count. The host streams drum hits by mutating `drumTab.hits` in
         * chunks, so object identity alone can leave the renderer stuck on the
         * first partial chunk of a real feedpak.
         *
         * @param {object|null} bundle - Host render bundle.
         * @returns {object|null} Projection returned by `projectDrumTab`.
         */
        function rememberProjection(projection) {
            lastProjectionStats = projection && projection.stats ? projection.stats : null;
            if (!lastProjectionStats || lastProjectionStats.rawHits <= 0 || lastProjectionStats.projectedHits > 0) return;
            const warningKey = [
                lastProjectionStats.source,
                lastProjectionStats.rawHits,
                settingsVersion,
                countMapKeys(lastProjectionStats.unknownPieces),
                countMapKeys(lastProjectionStats.unroutedPieces),
            ].join('|');
            if (warningKey === lastZeroProjectionWarningKey) return;
            lastZeroProjectionWarningKey = warningKey;
            console.warn('[Multipad-Hwy3D] projected zero notes from drum chart', lastProjectionStats);
        }

        function projectionForBundle(bundle) {
            const source = chartSourceFromBundle(bundle);
            if (source.type === 'drumTab') {
                if (!projectionCacheMatchesSource(source, {
                    sourceType: cachedProjectionSource,
                    drumTab: cachedDrumTab,
                    hitCount: cachedDrumHitCount,
                    settingsVersion: cachedSettingsVersion,
                })) {
                    const settings = readSettings();
                    const profile = readMultipadProfile();
                    cachedProjectionSource = source.type;
                    cachedDrumTab = source.drumTab;
                    cachedDrumHitCount = source.hitCount;
                    cachedSettingsVersion = settingsVersion;
                    cachedProjection = projectDrumTab(source.drumTab, {
                        padProfile: profile.padProfile,
                        pedalProfile: profile.pedalProfile,
                        triggerProfile: profile.triggerProfile,
                        hitGroupWindowSec: settings.hitGroupWindowMs / 1000,
                        source: source.type,
                    });
                    buildSurfaceGrid(cachedProjection.padProfile, cachedProjection.pedalProfile, cachedProjection.triggerProfile);
                    rememberProjection(cachedProjection);
                }
                return cachedProjection;
            }
            cachedProjectionSource = '';
            cachedDrumTab = null;
            cachedDrumHitCount = -1;
            cachedProjection = null;
            lastProjectionStats = null;
            cachedSettingsVersion = settingsVersion;
            return null;
        }

        /**
         * Restore surface materials and scales before rendering the current frame.
         *
         * @returns {void}
         */
        function resetSurfaceState() {
            for (const id of Object.keys(surfaces)) {
                const surface = surfaces[id];
                if (surface.material.emissive && surface.baseEmissiveColor != null) {
                    surface.material.emissive.setHex(surface.baseEmissiveColor);
                }
                surface.material.emissiveIntensity = surface.baseEmissiveIntensity;
                surface.material.opacity = surface.baseOpacity;
                surface.mesh.scale.set(1, 1, 1);
            }
        }

        /**
         * Resolve the render surface descriptor for a projected event.
         *
         * @param {object} event - Projected hit event.
         * @returns {object|null} Surface descriptor.
         */
        function surfaceForEvent(event) {
            return event && event.surfaceId ? (surfaces[event.surfaceId] || null) : null;
        }

        /**
         * Recompute how many seconds of lookahead NOTE_AHEAD_BEATS currently
         * represents, from the chart's local tempo around the current
         * playhead, and the depth a note now spawns at (NOTE_SPEED times
         * that). Uses the two bundle beats bracketing `t` so tempo changes
         * are picked up as playback passes through them, rather than a
         * single fixed BPM for the whole song. Falls back to
         * NOTE_AHEAD_FALLBACK_SEC when there's no usable beat grid (fewer
         * than 2 beats).
         *
         * @param {object|null} bundle - Host render bundle.
         * @param {number} t - Current chart time.
         * @returns {void}
         */
        function updateNoteAheadFromTempo(bundle, t) {
            const beats = bundle && Array.isArray(bundle.beats) ? bundle.beats : null;
            let secPerBeat = null;
            if (beats && beats.length >= 2) {
                const i = lowerBoundTimeField(beats, t);
                const hi = Math.min(beats.length - 1, Math.max(1, i));
                const lo = hi - 1;
                const interval = beats[hi].time - beats[lo].time;
                if (Number.isFinite(interval) && interval > 0) secPerBeat = interval;
            }
            activeNoteAheadSec = secPerBeat != null ? NOTE_AHEAD_BEATS * secPerBeat : NOTE_AHEAD_FALLBACK_SEC;
            activeNoteSpawnDepth = Math.max(0.001, activeNoteAheadSec * NOTE_SPEED);
        }

        /**
         * Return the first real-chart event index that can affect this frame.
         *
         * @param {object} projection - Current chart projection.
         * @param {number} t - Current chart time.
         * @returns {number} Start index for visible-event scanning.
         */
        function visibleEventStartIndex(projection, t) {
            const events = projection && projection.hitEvents ? projection.hitEvents : [];
            const minTime = t - NOTE_BEHIND_SEC;
            const mustRebase = renderCursorProjection !== projection
                || t < renderCursorTime
                || Math.abs(t - renderCursorTime) > RENDER_CURSOR_REBASE_SEC;
            if (mustRebase) {
                renderCursorProjection = projection;
                renderCursorIndex = lowerBoundHitEvents(events, minTime);
            } else {
                while (renderCursorIndex < events.length && events[renderCursorIndex].t < minTime) {
                    renderCursorIndex++;
                }
            }
            renderCursorTime = t;
            return renderCursorIndex;
        }

        /**
         * Draw a faint white outline of the whole pad grid's bounding box
         * traveling alongside an approaching note, so the hit group reads as
         * one unit as it moves down the highway. Uses the exact same
         * back-projection transform as the note's own position (anchored at
         * the grid's own center), so its center travels in step with the
         * note gem itself. Drawn at full (unscaled) size throughout - see
         * the "no separate size-shrink" comment in placeNote for why - so
         * only camera perspective, not an extra world-space scale curve,
         * makes it read as smaller while still far away.
         *
         * @param {number} z - Current depth, matching the note's own z.
         * @param {number} scaleProgress - Current clamped travel progress, matching the note's own.
         * @param {number} fadeInFactor - Spawn fade-in multiplier in [0, 1], matching the note's own.
         * @returns {void}
         */
        function placeLayoutPreview(z, scaleProgress, fadeInFactor) {
            if (!layoutPreviewGroup || !layoutPreviewGroupFrameGeometry) return;
            // The outline's own local offset from the grid center is
            // (0, 0) - it IS the grid center, at full (unscaled) size.
            const center = projectGridPoint(0, 0, scaleProgress);
            const group = acquireLayoutPreviewGroupMesh();
            group.mesh.position.set(center.x, center.y, z);
            group.mesh.scale.set(1, 1, 1);
            // Fade out as the note approaches - fully transparent by the
            // time it reaches the target, rather than staying at a flat
            // opacity all the way in - and fade in from spawn (see
            // placeNote) rather than popping in at full opacity.
            group.mesh.material.opacity = LAYOUT_PREVIEW_GROUP_OPACITY * (1 - scaleProgress) * fadeInFactor;
        }

        /**
         * Add a visible note mesh for one event at a time offset from the hit plane.
         *
         * @param {object} event - Projected hit event.
         * @param {number} dt - Seconds until hit time; positive means upstream.
         * @returns {void}
         */
        function placeNote(event, dt) {
            const surface = surfaceForEvent(event);
            if (!surface || !noteGeometry || !noteFaceGeometry || !notesGroup) return;
            // No hit detection exists yet (post-MVP), so every note is
            // effectively "unhandled" - keep it moving through the target at
            // the same speed instead of freezing it at the threshold. `z` is
            // allowed to go positive (past the hit plane, toward the camera)
            // once dt goes negative. Position keeps extrapolating along the
            // exact same back-point-to-target line it was already traveling
            // (positionProgress is not clamped above 1) instead of freezing
            // laterally and only pushing forward in z - that used to create a
            // visible kink in the travel direction right at the threshold.
            // Size still caps at the target's own dimensions once past
            // threshold (scaleProgress stays clamped to 1). Normalized
            // against activeNoteSpawnDepth (tempo-derived, see
            // updateNoteAheadFromTempo), not the fixed TUNNEL_DEPTH used
            // only for the cosmetic guide-line wireframe, so a note always
            // spawns at exactly progress=0 regardless of the chart's tempo.
            const z = -dt * NOTE_SPEED;
            const rawProgress = (z + activeNoteSpawnDepth) / activeNoteSpawnDepth;
            const positionProgress = Math.max(0, rawProgress);
            const scaleProgress = Math.min(1, positionProgress);
            // Same projectGridPoint the outline uses for its own center
            // (see that function's comment) - a pad's own offset from the
            // grid's center (surface.x, surface.y - GRID_CENTER_Y) is real
            // and constant, never separately compressed toward the
            // vanishing point.
            const point = projectGridPoint(surface.x, surface.y - GRID_CENTER_Y, positionProgress);
            const x = point.x;
            const y = point.y;
            const isPastThreshold = dt <= 0;
            const color = isPastThreshold ? NOTE_PAST_THRESHOLD_COLOR : eventColorForEvent(event);
            const note = acquireNoteMesh(
                getNoteMaterial(color, 'normal'),
                getNoteMaterial(color, 'front')
            );
            // No separate size-shrink curve: gems are always drawn at their
            // real target dimensions (surface.w/h), for every progress value
            // - not scaled up from a smaller spawn size. Two earlier passes
            // tried a world-space size curve tied to progress (first an
            // eased 43-68%-start curve, then TUNNEL_BACK_SCALE-based, then a
            // cubic-eased version of that) to keep distant gems from
            // overlapping their neighbors or the layout-preview outline -
            // but every version of "shrink size AND shrink position both as
            // functions of progress" compounds with the camera's own real
            // perspective divide, which already does the "looks smaller
            // when farther away" job on its own. Removing the extra curve
            // simplifies the highway back to one source of size truth (the
            // pad's real dimensions) and lets ordinary perspective account
            // for distance - at the cost of legitimately dense, evenly-timed
            // hit streams still crowding near spawn, same as any highway.
            const w = surface.w;
            const h = surface.h;
            const bodyH = Math.max(0.045, h);
            // With no size ramp to visually mark "just spawned," gems now
            // fade in from fully transparent instead - elapsedSinceSpawn is
            // how long this note has been visible (activeNoteAheadSec is
            // this frame's tempo-derived total flight time, dt counts down
            // from it to 0), clamped into a 0..1 ramp over
            // NOTE_SPAWN_FADE_SEC. Past-threshold notes are always long past
            // this window (dt <= 0 implies elapsed >= activeNoteAheadSec >>
            // NOTE_SPAWN_FADE_SEC), so it's a no-op there.
            const elapsedSinceSpawn = activeNoteAheadSec - dt;
            const fadeInFactor = Math.min(1, Math.max(0, elapsedSinceSpawn / NOTE_SPAWN_FADE_SEC));
            // Repeat dimming is a pad-grid-pattern cue (see PLANNING.md) -
            // pedal/trigger gems always render at full opacity regardless of
            // their own repeatedFromPreviousGroup value.
            const isRepeat = event.type === 'pad' && !!event.repeatedFromPreviousGroup;
            // Debug-only fields read by __probe()'s `notes` snapshot - not
            // used by any rendering path. Lets tests correlate a pooled
            // mesh back to the event that placed it this frame.
            note.debugSurfaceId = event.surfaceId;
            note.debugIsRepeat = isRepeat;
            note.debugIsPastThreshold = isPastThreshold;
            note.group.position.set(x, y, z);
            note.body.scale.set(w, bodyH, 0.11);
            note.face.scale.set(w, bodyH, 1);
            if (isPastThreshold) {
                // Color already snapped to gray above (isPastThreshold's
                // color branch) - no gradual color fade. Opacity ramps
                // linearly to fully invisible over NOTE_PAST_THRESHOLD_FADE_SEC
                // (see pastThresholdOpacity), always starting from the
                // dimmer repeat-gem level regardless of isRepeat - even a
                // fresh gem's own brighter NOTE_*_OPACITY read as too
                // bright/lingering the instant after crossing. dt is <= 0
                // here, so -dt is seconds elapsed since crossing.
                const secSinceCrossing = -dt;
                note.body.material.opacity = pastThresholdOpacity(NOTE_REPEAT_BODY_OPACITY * fadeInFactor, secSinceCrossing);
                note.face.material.opacity = pastThresholdOpacity(NOTE_REPEAT_FACE_OPACITY * fadeInFactor, secSinceCrossing);
            } else {
                note.body.material.opacity = (isRepeat ? NOTE_REPEAT_BODY_OPACITY : NOTE_BODY_OPACITY) * fadeInFactor;
                note.face.material.opacity = (isRepeat ? NOTE_REPEAT_FACE_OPACITY : NOTE_FACE_OPACITY) * fadeInFactor;
                if (!isRepeat && surface.kind === 'pad') {
                    placeLayoutPreview(z, scaleProgress, fadeInFactor);
                }
            }
        }

        /**
         * Return a point on a surface's border for a fraction `u` of the way
         * around it, so spark origins can be spread evenly around the whole
         * target instead of clustering at one spot.
         *
         * Rectangular surfaces are walked clockwise from the top-left corner,
         * proportional to each edge's length, so points are evenly spaced by
         * arc length rather than by corner count. Circular/ring surfaces walk
         * their radius instead.
         *
         * @param {object} surface - Surface descriptor (x, y, w, h, shape, radius).
         * @param {number} u - Fraction around the border, in [0, 1).
         * @returns {{x: number, y: number}} Border point in scene units.
         */
        function surfaceBorderPoint(surface, u) {
            if (surface.shape === 'circle' || surface.shape === 'ring') {
                const r = surface.radius || surface.w * 0.5;
                const ang = u * Math.PI * 2;
                return { x: surface.x + Math.cos(ang) * r, y: surface.y + Math.sin(ang) * r };
            }
            const w = surface.w;
            const h = surface.h;
            const halfW = w * 0.5;
            const halfH = h * 0.5;
            const perimeter = Math.max(0.0001, 2 * (w + h));
            let d = u * perimeter;
            if (d < w) return { x: surface.x - halfW + d, y: surface.y + halfH };
            d -= w;
            if (d < h) return { x: surface.x + halfW, y: surface.y + halfH - d };
            d -= h;
            if (d < w) return { x: surface.x + halfW - d, y: surface.y - halfH };
            d -= w;
            return { x: surface.x - halfW, y: surface.y - halfH + d };
        }

        /**
         * Spawn spark bursts spread evenly around a surface's whole border.
         *
         * @param {object} surface - Surface descriptor.
         * @param {number} hex - Spark color.
         * @param {number} totalCount - Total spark particles across all origins.
         * @returns {void}
         */
        function sparkBorderBurst(surface, hex, totalCount) {
            const origins = 8;
            const perOrigin = Math.max(1, Math.round(totalCount / origins));
            for (let i = 0; i < origins; i++) {
                const p = surfaceBorderPoint(surface, i / origins);
                sparkBurst(p.x, p.y, 0.08, hex, perOrigin);
            }
        }

        function crossingFxKey(event, cycleBase) {
            return [
                cycleBase || 0,
                event && event.t,
                event && event.surfaceId,
                event && event.piece,
            ].join(':');
        }

        function triggerEventFx(event) {
            const surface = surfaceForEvent(event);
            if (!surface || !surface.active) return;
            const color = timingHex(event);
            const intensity = activeSettings.feedbackIntensity || 0;
            if (intensity <= 0) return;
            const sparkCount = Math.max(6, Math.round(10 + 10 * intensity));
            const isKick = event.piece === 'kick' || event.surfaceId === 'outline-bottom';
            if (isKick) kickPulse = Math.max(kickPulse, 1);
            sparkBorderBurst(surface, isKick ? KICK_COLOR : color, isKick ? sparkCount * 3 : sparkCount);
        }

        function maybeTriggerCrossingFx(event, dt, cycleBase) {
            if (dt > 0 || dt < -NOTE_BEHIND_SEC) return;
            const key = crossingFxKey(event, cycleBase);
            if (crossedEventFxKeys.has(key)) return;
            crossedEventFxKeys.add(key);
            triggerEventFx(event);
        }

        /**
         * Rebuild visible note meshes and crossing effects for the current frame.
         *
         * @param {object|null} bundle - Host render bundle.
         * @returns {void}
         */
        function renderEvents(bundle) {
            if (!notesGroup) return;
            clearTransientNotes();
            clearTransientLayoutPreviews();
            const projection = projectionForBundle(bundle);
            resetSurfaceState();
            if (!projection) return;

            const t = Number.isFinite(bundle && bundle.currentTime)
                ? bundle.currentTime
                : 0;
            updateNoteAheadFromTempo(bundle, t);
            const events = projection.hitEvents;
            if (crossingFxProjection !== projection || t < crossingFxTime - 0.05 || Math.abs(t - crossingFxTime) > RENDER_CURSOR_REBASE_SEC) {
                crossedEventFxKeys = new Set();
                crossingFxProjection = projection;
            }
            crossingFxTime = t;
            const startIndex = visibleEventStartIndex(projection, t);
            for (let i = startIndex; i < events.length; i++) {
                const event = events[i];
                const dt = event.t - t;
                if (dt > activeNoteAheadSec) break;
                if (dt < -NOTE_BEHIND_SEC) continue;
                placeNote(event, dt);
                maybeTriggerCrossingFx(event, dt, 0);
            }
        }

        function updateWallClockFx() {
            const nowMs = typeof performance !== 'undefined' && performance && typeof performance.now === 'function'
                ? performance.now()
                : Date.now();
            const dt = fxLastWall === 0 ? 1 / 60 : Math.min(0.05, (nowMs - fxLastWall) / 1000);
            fxLastWall = nowMs;
            updateSparks(dt);
            updateBackground(dt, nowMs / 1000);
            const intensity = activeSettings.feedbackIntensity || 0;
            if (kickPulse > 0.001 && camera) {
                kickPulse *= Math.exp(-dt * KICK_SHAKE_DECAY);
                camera.position.y = baseCameraY - KICK_SHAKE_MAGNITUDE * kickPulse * intensity;
            } else if (kickPulse !== 0) {
                kickPulse = 0;
                if (camera) camera.position.y = baseCameraY;
            }
        }

        /**
         * Dispose renderer-owned resources and clear instance state.
         *
         * @returns {void}
         */
        function teardown() {
            ready = false;
            clearTransientNotes();
            if (scene) disposeObjectTree(scene);
            if (renderer) renderer.dispose();
            disposeNoteMaterials();
            // Never entered the scene graph (only its .clone()s did), so
            // disposeObjectTree(scene) above never reaches it either.
            if (layoutPreviewGroupMaterial && typeof layoutPreviewGroupMaterial.dispose === 'function') {
                layoutPreviewGroupMaterial.dispose();
            }
            canvas = null;
            lastBundle = null;
            scene = null;
            camera = null;
            renderer = null;
            highwayGroup = null;
            surfaceGroup = null;
            notesGroup = null;
            tunnelLinesMesh = null;
            layoutPreviewGroup = null;
            layoutPreviewGroupFrameGeometry = null;
            layoutPreviewGroupMaterial = null;
            layoutPreviewGroupMeshPool = [];
            visibleLayoutPreviewGroupCount = 0;
            labelGroup = null;
            surfaces = Object.create(null);
            noteGeometry = null;
            noteFaceGeometry = null;
            floorMesh = null;
            ambientLight = null;
            keyLight = null;
            bgGroup = null;
            bgState = null;
            activeBackgroundKey = '';
            crossedEventFxKeys = new Set();
            crossingFxProjection = null;
            crossingFxTime = -Infinity;
            sparkPoints = null;
            sparkPos = null;
            sparkCol = null;
            sparkVel = null;
            sparkLife = null;
            fxLastWall = 0;
            kickPulse = 0;
            baseCameraY = 0;
            noteMeshPool = [];
            cachedDrumTab = null;
            cachedDrumHitCount = -1;
            cachedProjectionSource = '';
            cachedProjection = null;
            lastProjectionStats = null;
            lastZeroProjectionWarningKey = '';
            renderCursorProjection = null;
            renderCursorIndex = 0;
            renderCursorTime = -Infinity;
            activeNoteAheadSec = NOTE_AHEAD_FALLBACK_SEC;
            activeNoteSpawnDepth = NOTE_AHEAD_FALLBACK_SEC * NOTE_SPEED;
            activeSurfaceLayoutKey = null;
            visibleNoteCount = 0;
        }

        const instance = {
            contextType: CONTEXT_TYPE,

            init(nextCanvas, bundle) {
                if (renderer || scene) teardown();
                const initGeneration = ++generation;
                canvas = nextCanvas || null;
                lastBundle = bundle || null;
                destroyed = false;
                ready = false;
                liveInstances.add(instance);
                if (!canvas) return;

                loadThree().then(() => {
                    if (destroyed || initGeneration !== generation || !canvas) return;
                    try {
                        renderer = new T.WebGLRenderer({
                            canvas,
                            antialias: true,
                            alpha: false,
                            powerPreference: 'high-performance',
                        });
                        renderer.setClearColor(SCENE_COLORS.clear, 1);
                        initScene();
                        applySize(canvas.clientWidth || canvas.width || lastWidth, canvas.clientHeight || canvas.height || lastHeight);
                    } catch (err) {
                        // initScene used to run outside this try/catch, so an
                        // exception there (bad pad-profile geometry, etc.)
                        // fell through to the outer .catch below, which
                        // teardown()s silently with no console output - a
                        // real scene-build bug then looked exactly like "the
                        // canvas never rendered anything," with no error
                        // logged anywhere to point at why.
                        console.error('[Multipad-Hwy3D] scene init failed:', err);
                        teardown();
                        return;
                    }
                    ready = true;
                    instance.draw(lastBundle);
                }).catch(err => {
                    console.error('[Multipad-Hwy3D] Three.js load failed:', err);
                    if (!destroyed) teardown();
                });
            },

            draw(bundle) {
                if (destroyed) return;
                lastBundle = bundle || lastBundle;
                if (!ready || !renderer || !scene || !camera) return;
                updateSettingsFromStorage();
                const nextScale = (lastBundle && Number.isFinite(lastBundle.renderScale)) ? lastBundle.renderScale : 1;
                if (nextScale !== renderScale) {
                    renderScale = nextScale;
                    applySize(canvas && canvas.clientWidth, canvas && canvas.clientHeight);
                }
                if (canvas) {
                    const w = canvas.clientWidth || canvas.width || lastWidth;
                    const h = canvas.clientHeight || canvas.height || lastHeight;
                    if (w && h && (Math.abs(w - lastWidth) > 1 || Math.abs(h - lastHeight) > 1)) {
                        applySize(w, h);
                    }
                }
                renderEvents(lastBundle);
                updateWallClockFx();
                renderer.render(scene, camera);
            },

            resize(width, height) {
                lastWidth = Number.isFinite(width) ? Math.max(0, width) : 0;
                lastHeight = Number.isFinite(height) ? Math.max(0, height) : 0;
                if (ready) applySize(lastWidth, lastHeight);
            },

            destroy() {
                liveInstances.delete(instance);
                destroyed = true;
                generation++;
                teardown();
                lastWidth = 0;
                lastHeight = 0;
            },

            __probe() {
                return {
                    pluginId: PLUGIN_ID,
                    contextType: CONTEXT_TYPE,
                    initialized: !!canvas && !destroyed,
                    ready,
                    width: lastWidth,
                    height: lastHeight,
                    hasBundle: !!lastBundle,
                    surfaces: Object.keys(surfaces).length,
                    // Per-surface fill/edge color+opacity snapshot, keyed the
                    // same as the internal `surfaces` map - lets tests verify
                    // the actual applied Three.js material state (e.g. "does
                    // an assigned pedal surface really get a colored edge")
                    // rather than only the pre-render layout descriptors.
                    surfaceStyles: Object.fromEntries(Object.entries(surfaces).map(([key, s]) => [key, {
                        kind: s.kind,
                        active: !!s.active,
                        fillColor: s.material && s.material.color && typeof s.material.color.getHex === 'function' ? s.material.color.getHex() : null,
                        fillOpacity: s.material ? s.material.opacity : null,
                        edgeColor: s.edgeMaterial && s.edgeMaterial.color && typeof s.edgeMaterial.color.getHex === 'function' ? s.edgeMaterial.color.getHex() : null,
                        edgeOpacity: s.edgeMaterial ? s.edgeMaterial.opacity : null,
                    }])),
                    // This frame's visible note gems, in placement order -
                    // lets tests verify actual applied opacity (e.g. "do
                    // repeat and non-repeat past-threshold gems really start
                    // their fade at the same opacity") instead of only the
                    // pastThresholdOpacity helper in isolation.
                    notes: noteMeshPool.slice(0, visibleNoteCount).map(e => ({
                        surfaceId: e.debugSurfaceId,
                        isRepeat: !!e.debugIsRepeat,
                        isPastThreshold: !!e.debugIsPastThreshold,
                        bodyOpacity: e.body.material.opacity,
                        faceOpacity: e.face.material.opacity,
                    })),
                    // Flat [x, y, z, ...] vertex array of the whole-grid
                    // tunnel guide-line geometry (see addTunnelLines) - lets
                    // tests verify the back corners land exactly where
                    // projectGridPoint(offset, offset, 0) puts them, the same
                    // formula note gems spawn from.
                    tunnelLineVertices: tunnelLinesMesh && tunnelLinesMesh.geometry && tunnelLinesMesh.geometry.attributes.position
                        ? Array.from(tunnelLinesMesh.geometry.attributes.position.array)
                        : null,
                    // One entry per built label sprite (only built while
                    // showLabels is on - see buildSurfaceGrid), with the
                    // actual rendered text lines recovered from the canvas
                    // 2D context createLabelSprite drew onto - lets tests
                    // verify real (not abbreviated) piece names are used,
                    // that multi-piece pads get one line per piece, and
                    // that pedal/trigger surfaces get labels too.
                    labels: labelGroup ? labelGroup.children.map(l => {
                        const canvas = l.material && l.material.map ? l.material.map.image : null;
                        const ctx2d = canvas && typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;
                        const fillCalls = ctx2d && Array.isArray(ctx2d.fillCalls) ? ctx2d.fillCalls : [];
                        return {
                            surfaceKey: (l.userData && l.userData.surfaceKey) || null,
                            lines: fillCalls.map(c => c.text),
                            // Parsed px size from each line's final `font`
                            // string (after any width-based shrink loop) -
                            // lets tests verify the font actually scales
                            // down for many stacked lines instead of
                            // pinning at a fixed floor.
                            fontSizes: fillCalls.map(c => {
                                const m = /(\d+)px/.exec(c.font || '');
                                return m ? Number(m[1]) : null;
                            }),
                        };
                    }) : [],
                    labelsVisible: labelGroup ? !!labelGroup.visible : false,
                    drumTabPresent: !!(lastBundle && lastBundle.drumTab),
                    drumTabHits: hasDrumTabHitStream(lastBundle && lastBundle.drumTab) ? lastBundle.drumTab.hits.length : 0,
                    projectionSource: cachedProjectionSource,
                    projectedHits: cachedProjection ? cachedProjection.hitEvents.length : 0,
                    projectionStats: lastProjectionStats,
                    profileId: lastProjectionStats ? lastProjectionStats.profileId : activeSettings.profileId,
                    padProfileId: lastProjectionStats ? lastProjectionStats.padProfileId : activeSettings.padProfileId,
                    pedalProfileId: lastProjectionStats ? lastProjectionStats.pedalProfileId : activeSettings.pedalProfileId,
                    triggerProfileId: lastProjectionStats ? lastProjectionStats.triggerProfileId : activeSettings.triggerProfileId,
                    visibleNotes: visibleNoteCount,
                    showLabels: !!activeSettings.showLabels,
                    cameraAngle: activeSettings.cameraAngle,
                    sceneTheme: activeSettings.sceneTheme,
                    feedbackIntensity: activeSettings.feedbackIntensity,
                    timingColors: activeSettings.timingColors,
                    hitSparks: activeSettings.hitSparks,
                    cinematicLighting: activeSettings.cinematicLighting,
                    backgroundStyle: activeSettings.backgroundStyle,
                    backgroundIntensity: activeSettings.backgroundIntensity,
                };
            },
        };

        return instance;
    }

    // ---------------------------------------------------------------------
    // Public and Test APIs
    // ---------------------------------------------------------------------

    function createTestApi() {
        return {
            pluginId: PLUGIN_ID,
            contextType: CONTEXT_TYPE,
            matchesArrangement,
            GRID_CENTER_Y,
            TUNNEL_BACK_X_OFFSET,
            TUNNEL_BACK_LIFT,
            TUNNEL_DEPTH,
            ALL_PIECES: ALL_PIECES.slice(),
            PAD_PIECES: PAD_PIECES.slice(),
            PEDAL_PIECES: PEDAL_PIECES.slice(),
            PEDAL_SURFACES: PEDAL_SURFACES.slice(),
            TRIGGER_SURFACES: TRIGGER_SURFACES.slice(),
            PIECE_LABELS: Object.assign({}, PIECE_LABELS),
            PIECE_FRIENDLY_LABELS: Object.assign({}, PIECE_FRIENDLY_LABELS),
            friendlyPieceLabel,
            DEFAULT_PAD_PROFILE: clonePadProfile(DEFAULT_PAD_PROFILE),
            DEFAULT_PEDAL_PROFILE: clonePedalProfile(DEFAULT_PEDAL_PROFILE),
            DEFAULT_TRIGGER_PROFILE: cloneTriggerProfile(DEFAULT_TRIGGER_PROFILE),
            DEFAULT_SETTINGS: Object.assign({}, DEFAULT_SETTINGS),
            DEFAULT_PROFILE: cloneMultipadProfile(DEFAULT_PROFILE),
            BUILTIN_PAD_PROFILE_IDS: Object.keys(BUILTIN_PAD_PROFILES),
            validatePadProfile,
            validatePedalProfile,
            validateTriggerProfile,
            validateMultipadProfile,
            collectAssignedPieces,
            colorHexFromCss,
            cssColorFromHex,
            readSettings,
            readMultipadProfile,
            writeMultipadProfile,
            writeSetting,
            buildPieceToPadMap,
            buildPieceToPedalMap,
            buildPieceToTriggerMap,
            hasDrumTabHitStream,
            chartSourceFromBundle,
            projectionCacheMatchesSource,
            buildSurfaceLayout,
            padProfileLayoutKey,
            profileForPadLayout,
            lowerBoundHitEvents,
            normalizeTimingStatus,
            hitVariant,
            normalizeHit,
            groupHitEvents,
            projectDrumTab,
            projectGridPoint,
            projectRectCorners,
            pastThresholdOpacity,
            NOTE_PAST_THRESHOLD_FADE_SEC,
            NOTE_BEHIND_SEC,
            TARGET_ZONE_FILL_OPACITY,
            TARGET_ZONE_EDGE_OPACITY,
            NOTE_BODY_OPACITY,
            NOTE_FACE_OPACITY,
            NOTE_REPEAT_BODY_OPACITY,
            NOTE_REPEAT_FACE_OPACITY,
            liveInstanceCount() {
                return liveInstances.size;
            },
        };
    }

    function installSettingsGlobals(target) {
        target.multipadH3dGetProfile = function () {
            return cloneMultipadProfile(readMultipadProfile());
        };
        // Same-window call (settings.html's inline <script> shares this
        // global scope, not a serialized message-passing boundary), so
        // `options.skip*` predicates pass through as real function
        // references - callers can filter against whichever pad/pedal/
        // trigger entry they're currently editing without settings.html
        // maintaining its own independent copy of this walk.
        target.multipadH3dGetAssignedPieces = function (profile, options) {
            return collectAssignedPieces(profile, options);
        };
        target.multipadH3dSetProfile = function (raw) {
            return writeMultipadProfile(raw);
        };
        target.multipadH3dResetProfile = function () {
            return writeMultipadProfile(DEFAULT_PROFILE);
        };
        target.multipadH3dCreateProfileForLayout = function (layoutId) {
            return cloneMultipadProfile(profileForPadLayout(layoutId));
        };
        target.multipadH3dGetPadLayouts = function () {
            return Object.keys(BUILTIN_PAD_PROFILES).map(id => ({
                id,
                name: BUILTIN_PAD_PROFILES[id].name,
                rows: BUILTIN_PAD_PROFILES[id].rows,
                cols: BUILTIN_PAD_PROFILES[id].cols,
            }));
        };
        target.multipadH3dGetAllPieces = function () {
            return ALL_PIECES.slice();
        };
        target.multipadH3dGetPieceLabels = function () {
            return Object.assign({}, PIECE_LABELS);
        };
        target.multipadH3dGetPieceFriendlyLabels = function () {
            return Object.assign({}, PIECE_FRIENDLY_LABELS);
        };
        target.multipadH3dGetPieceColors = function () {
            const out = {};
            for (const piece of ALL_PIECES) out[piece] = cssColorFromHex(PIECE_COLORS[piece]);
            return out;
        };
        target.multipadH3dGetSettings = function () {
            return Object.assign({}, readSettings());
        };
        target.multipadH3dSetSetting = function (key, value) {
            writeSetting(key, value);
        };
        target.multipadH3dGetSceneThemes = function () {
            return Object.keys(SCENE_THEMES);
        };
    }

    function createRuntimeProbeApi() {
        return {
            getState() {
                const instances = Array.from(liveInstances)
                    .map(inst => inst && typeof inst.__probe === 'function' ? inst.__probe() : null)
                    .filter(Boolean);
                return {
                    pluginId: PLUGIN_ID,
                    contextType: CONTEXT_TYPE,
                    liveInstances: liveInstances.size,
                    autoClaims: matchesArrangement({ has_drum_tab: true, arrangement: 'Drums' }),
                    instances,
                };
            },
        };
    }

    createFactory.contextType = CONTEXT_TYPE;
    createFactory.matchesArrangement = matchesArrangement;
    createFactory.__test = createTestApi();

    installSettingsGlobals(window);
    window.feedBackViz_multipad_highway_3d = createFactory;
    window.__multipadH3dTest = createRuntimeProbeApi();
    // ---------------------------------------------------------------------
    // Player Controls - Target Labels Toggle
    // ---------------------------------------------------------------------

    const LABELS_BTN_ID = 'multipad-h3d-labels-toggle';

    /**
     * Resolve the v3 plugin-control slot (the "Plugins" rail popover), or
     * null in v2 / when the host API isn't available. See
     * docs/plugin-v3-ui.md's canonical injection pattern - v2's
     * `#player-controls` bar is a fixed always-visible container, but v3's
     * is a minimal auto-hiding transport with no reliable insertion anchor,
     * so any player-controls injection must detect v3 and mount into this
     * slot instead.
     *
     * @returns {Element|null}
     */
    function playerSlot() {
        if (!(window.feedBack && window.feedBack.uiVersion === 'v3'
            && window.feedBack.ui && typeof window.feedBack.ui.playerControlSlot === 'function')) {
            return null;
        }
        try {
            return window.feedBack.ui.playerControlSlot();
        } catch (_e) {
            // Host slot API failure - fall back to the legacy v2 bar rather
            // than letting the exception propagate out of the caller.
            return null;
        }
    }

    /**
     * Sync the injected toggle button's pressed/unpressed visual state with
     * the current showLabels setting. Safe to call whether or not the
     * button has been injected yet.
     *
     * @returns {void}
     */
    function updateLabelsButton() {
        if (typeof document === 'undefined') return;
        const btn = document.getElementById(LABELS_BTN_ID);
        if (!btn) return;
        const on = !!readSettings().showLabels;
        btn.className = on
            ? 'px-3 py-1.5 bg-accent/20 hover:bg-accent/30 border border-accent rounded-lg text-xs text-accent transition'
            : 'px-3 py-1.5 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-400 transition';
        btn.setAttribute('aria-pressed', String(on));
    }

    /**
     * Inject the "Labels" toggle button into the player controls, once per
     * screen (guarded by element id - re-entering the player screen is a
     * no-op if the button is already there). Mirrors the pattern used
     * elsewhere in this app for a player-injected control (see
     * docs/plugin-v3-ui.md): v3 mounts into the stable plugin-control slot,
     * v2 falls back to `#player-controls`, inserting before the legacy
     * separator/close-button anchor only in v2 (that anchor doesn't exist
     * in the v3 transport).
     *
     * This single button controls visibility for every multipad target
     * label - pads, pedal surfaces, and external triggers alike (see
     * buildSurfaceGrid/buildSurfaceLabel in 04-renderer.js) - since they
     * all read the same `showLabels` setting this button flips.
     *
     * @returns {void}
     */
    function injectLabelsToggleButton() {
        if (typeof document === 'undefined') return;
        const slot = playerSlot();
        const controls = slot || document.getElementById('player-controls');
        if (!controls || document.getElementById(LABELS_BTN_ID)) return;
        const btn = document.createElement('button');
        btn.id = LABELS_BTN_ID;
        btn.type = 'button';
        btn.textContent = 'Labels';
        btn.title = 'Toggle multipad target labels';
        btn.setAttribute('aria-label', 'Toggle multipad target labels');
        btn.onclick = () => {
            writeSetting('showLabels', !readSettings().showLabels);
            updateLabelsButton();
        };
        const anchor = slot ? null : controls.querySelector('span.text-gray-700, button:last-child');
        if (anchor) controls.insertBefore(btn, anchor);
        else controls.appendChild(btn);
        updateLabelsButton();
    }

    if (typeof window !== 'undefined' && window.feedBack && typeof window.feedBack.on === 'function') {
        window.feedBack.on('screen:changed', (ev) => {
            if (ev && ev.detail && ev.detail.id === 'player') injectLabelsToggleButton();
        });
        if (typeof document !== 'undefined' && document.querySelector
            && (document.querySelector('.screen.active') || {}).id === 'player') {
            injectLabelsToggleButton();
        }
    }

    // Exposed for tests, which drive injection directly against a stubbed
    // document/window.feedBack rather than the real screen:changed event.
    if (createFactory.__test) {
        createFactory.__test.injectLabelsToggleButton = injectLabelsToggleButton;
        createFactory.__test.updateLabelsButton = updateLabelsButton;
        createFactory.__test.LABELS_BTN_ID = LABELS_BTN_ID;
    }
})();
