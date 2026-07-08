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

