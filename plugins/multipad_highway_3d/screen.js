// Multipad Highway 3D visualization plugin.
//
// Phase 4 MVP: validatePadProfile/validatePedalProfile/
// validateTriggerProfile normalize the configurable surface,
// buildPieceToPadMap/buildPieceToPedalMap/buildPieceToTriggerMap route drum
// pieces, and the renderer projects those events into a 3D multipad highway.

(function () {
    'use strict';

    /** Stable plugin id; must match plugin.json and the feedBackViz global name. */
    const PLUGIN_ID = 'multipad_highway_3d';
    const CONTEXT_TYPE = 'webgl2';
    const THREE_URL = '/static/vendor/three/three.module.min.js';
    const THREE_CDN = 'https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.min.js';
    let T = null;
    let threeLoadPromise = null;

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
        'crash_l', 'crash_r', 'splash', 'china',
        'ride', 'ride_bell',
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
        'external-left-center', 'external-left-edge',
        'external-right-center', 'external-right-edge',
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
        crash_l: 'CRl',
        crash_r: 'CRr',
        splash: 'SPL',
        china: 'CHN',
        ride: 'RD',
        ride_bell: 'BLL',
    };
    /**
     * MVP routing fallbacks for pieces that do not have their own built-in pad.
     * These adapt the drum highway's kit fallback idea to a pad grid without
     * changing the original chart piece id.
     */
    const PIECE_FALLBACKS = {
        snare_xstick: 'snare',
        hh_open: 'hh_closed',
        tom_low: 'tom_mid',
        crash_r: 'crash_l',
        splash: 'crash_l',
        china: 'crash_l',
        ride_bell: 'ride',
    };

    /**
     * Built-in MVP pad layout. It is intentionally named as a generic pad grid
     * even though the first profile is 3x3, so future 2x4, 4x3, or 1x12
     * profiles can use the same validation and projection helpers.
     */
    const DEFAULT_PAD_PROFILE = Object.freeze({
        version: 1,
        id: 'generic-3x3',
        name: 'Generic pad grid (MVP 3x3)',
        rows: 3,
        cols: 3,
        pads: Object.freeze([
            Object.freeze({ id: '1', row: 0, col: 0, label: 'CRl', pieces: Object.freeze(['crash_l', 'splash', 'china']) }),
            Object.freeze({ id: '2', row: 0, col: 1, label: 'HH', pieces: Object.freeze(['hh_closed', 'hh_open']) }),
            Object.freeze({ id: '3', row: 0, col: 2, label: 'CRr', pieces: Object.freeze(['crash_r']) }),
            Object.freeze({ id: '4', row: 1, col: 0, label: 'TM1', pieces: Object.freeze(['tom_hi']) }),
            Object.freeze({ id: '5', row: 1, col: 1, label: 'TM2', pieces: Object.freeze(['tom_mid', 'tom_low']) }),
            Object.freeze({ id: '6', row: 1, col: 2, label: 'RD', pieces: Object.freeze(['ride', 'ride_bell']) }),
            Object.freeze({ id: '7', row: 2, col: 0, label: 'XSTK', pieces: Object.freeze(['snare_xstick']) }),
            Object.freeze({ id: '8', row: 2, col: 1, label: 'SNR', pieces: Object.freeze(['snare']) }),
            Object.freeze({ id: '9', row: 2, col: 2, label: 'FT', pieces: Object.freeze(['tom_floor']) }),
        ]),
        fallbacks: Object.freeze(Object.assign({}, PIECE_FALLBACKS)),
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
                color: '#22d3ee',
            }),
            Object.freeze({
                id: 'kick',
                surface: 'outline-bottom',
                label: 'KICK',
                pieces: Object.freeze(['kick']),
                color: '#facc15',
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
        triggers: Object.freeze([]),
    });

    /** Settings used by the data layer before the settings UI becomes live. */
    const DEFAULT_SETTINGS = Object.freeze({
        padProfileId: DEFAULT_PAD_PROFILE.id,
        pedalProfileId: DEFAULT_PEDAL_PROFILE.id,
        triggerProfileId: DEFAULT_TRIGGER_PROFILE.id,
        showLabels: true,
        hitGroupWindowMs: 8,
    });

    const PIECE_COLORS = Object.freeze({
        kick: 0xfacc15,
        snare: 0xf472b6,
        snare_xstick: 0xfb7185,
        hh_closed: 0x22d3ee,
        hh_open: 0x67e8f9,
        hh_pedal: 0x22d3ee,
        tom_hi: 0x38bdf8,
        tom_mid: 0x60a5fa,
        tom_low: 0x818cf8,
        tom_floor: 0xa78bfa,
        crash_l: 0xfb923c,
        crash_r: 0xf97316,
        splash: 0xfbbf24,
        china: 0xef4444,
        ride: 0x34d399,
        ride_bell: 0xa7f3d0,
    });
    const SCENE_COLORS = Object.freeze({
        clear: 0x080b12,
        fog: 0x101827,
        pad: 0x192536,
        padEdge: 0x38516f,
        surface: 0x7dd3fc,
        tunnel: 0x24425e,
        floor: 0x0b111a,
        text: '#dbeafe',
    });
    const PAD_W = 1.18;
    const PAD_H = 0.78;
    const PAD_GAP = 0.16;
    const EXTERNAL_TRIGGER_PAD_DIAMETER = PAD_H;
    const EXTERNAL_TRIGGER_PAD_EDGE_WIDTH = 0.14;
    const GRID_CENTER_Y = 1.22;
    const TUNNEL_DEPTH = 18;
    const TUNNEL_BACK_SCALE = 0.55;
    const NOTE_SPEED = 6.2;
    const NOTE_AHEAD_SEC = 3.0;
    const NOTE_BEHIND_SEC = 0.28;
    const HIT_PULSE_SEC = 0.16;
    const DEMO_PATTERN_SEC = 4;
    const RENDER_CURSOR_REBASE_SEC = 0.75;
    /** localStorage keys are namespaced so this plugin never collides with drum_h3d. */
    const LS_KEYS = Object.freeze({
        padProfileId: 'multipad_h3d_pad_profile',
        pedalProfileId: 'multipad_h3d_pedal_profile',
        triggerProfileId: 'multipad_h3d_trigger_profile',
        showLabels: 'multipad_h3d_show_labels',
        hitGroupWindowMs: 'multipad_h3d_hit_group_window_ms',
    });

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

    /**
     * Find the first sorted hit event whose time is at or after `minTime`.
     *
     * @param {Array<object>} hitEvents - Sorted projected hit events.
     * @param {number} minTime - Earliest visible event time.
     * @returns {number} Start index into `hitEvents`.
     */
    function lowerBoundHitEvents(hitEvents, minTime) {
        let lo = 0;
        let hi = Array.isArray(hitEvents) ? hitEvents.length : 0;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (hitEvents[mid].t < minTime) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    }

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
        };
    }

    /**
     * Return a stable key for the pad geometry that should currently be drawn.
     *
     * @param {object} profile - Validated or raw pad profile.
     * @returns {string} Stable layout key.
     */
    function padProfileLayoutKey(profile) {
        const valid = validatePadProfile(profile) || clonePadProfile(DEFAULT_PAD_PROFILE);
        const pads = valid.pads
            .map(pad => [pad.id, pad.row, pad.col, pad.label].join(':'))
            .sort()
            .join('|');
        return [valid.id, valid.rows, valid.cols, pads].join('|');
    }

    /**
     * Build pure render-surface descriptors for a pad profile.
     *
     * @param {object} profile - Validated or raw pad profile.
     * @returns {{layoutKey: string, rows: number, cols: number, gridW: number, gridH: number, surfaces: Array<object>}}
     */
    function buildSurfaceLayout(profile) {
        const valid = validatePadProfile(profile) || clonePadProfile(DEFAULT_PAD_PROFILE);
        const rows = Math.max(1, valid.rows);
        const cols = Math.max(1, valid.cols);
        const gridW = cols * PAD_W + (cols - 1) * PAD_GAP;
        const gridH = rows * PAD_H + (rows - 1) * PAD_GAP;
        const surfaces = [];

        for (const pad of valid.pads) {
            surfaces.push({
                key: 'pad:' + pad.id,
                kind: 'pad',
                shape: 'plane',
                x: (pad.col - (cols - 1) / 2) * (PAD_W + PAD_GAP),
                y: GRID_CENTER_Y + ((rows - 1) / 2 - pad.row) * (PAD_H + PAD_GAP),
                w: PAD_W,
                h: PAD_H,
                color: SCENE_COLORS.surface,
                opacity: 0.82,
                pad,
            });
        }

        const topY = GRID_CENTER_Y + gridH / 2 + 0.24;
        const bottomY = GRID_CENTER_Y - gridH / 2 - 0.24;
        const sideX = gridW / 2 + 0.25;
        const externalPadRadius = EXTERNAL_TRIGGER_PAD_DIAMETER / 2;
        const externalPadCenterRadius = externalPadRadius - EXTERNAL_TRIGGER_PAD_EDGE_WIDTH;
        const externalPadX = gridW / 2 + 0.25 + 0.11 / 2 + externalPadRadius + 0.22;
        surfaces.push(
            { key: 'outline-top', kind: 'pedal-outline', shape: 'plane', x: 0, y: topY, w: gridW, h: 0.11, color: PIECE_COLORS.hh_pedal, opacity: 0.2 },
            { key: 'outline-bottom', kind: 'pedal-outline', shape: 'plane', x: 0, y: bottomY, w: gridW, h: 0.13, color: PIECE_COLORS.kick, opacity: 0.22 },
            { key: 'outline-left', kind: 'trigger-outline', shape: 'plane', x: -sideX, y: GRID_CENTER_Y, w: 0.11, h: gridH, color: 0xa78bfa, opacity: 0.16 },
            { key: 'outline-right', kind: 'trigger-outline', shape: 'plane', x: sideX, y: GRID_CENTER_Y, w: 0.11, h: gridH, color: 0xa78bfa, opacity: 0.16 },
            { key: 'external-left-center', kind: 'external-trigger-center', shape: 'circle', x: -externalPadX, y: GRID_CENTER_Y, w: externalPadCenterRadius * 2, h: externalPadCenterRadius * 2, radius: externalPadCenterRadius, color: 0xfde68a, opacity: 0.48 },
            { key: 'external-left-edge', kind: 'external-trigger-edge', shape: 'ring', x: -externalPadX, y: GRID_CENTER_Y, w: EXTERNAL_TRIGGER_PAD_DIAMETER, h: EXTERNAL_TRIGGER_PAD_DIAMETER, innerRadius: externalPadCenterRadius, outerRadius: externalPadRadius, color: 0xfacc15, opacity: 0.82 },
            { key: 'external-right-center', kind: 'external-trigger-center', shape: 'circle', x: externalPadX, y: GRID_CENTER_Y, w: externalPadCenterRadius * 2, h: externalPadCenterRadius * 2, radius: externalPadCenterRadius, color: 0xfdba74, opacity: 0.48 },
            { key: 'external-right-edge', kind: 'external-trigger-edge', shape: 'ring', x: externalPadX, y: GRID_CENTER_Y, w: EXTERNAL_TRIGGER_PAD_DIAMETER, h: EXTERNAL_TRIGGER_PAD_DIAMETER, innerRadius: externalPadCenterRadius, outerRadius: externalPadRadius, color: 0xf97316, opacity: 0.82 }
        );

        return {
            layoutKey: padProfileLayoutKey(valid),
            rows,
            cols,
            gridW,
            gridH,
            surfaces,
        };
    }

    /**
     * Validate and normalize a pad layout.
     *
     * The profile accepts explicit m x n layouts and drum piece ids, but rejects
     * pedal pieces because the pedal profile owns pedal surface rendering.
     * Invalid top-level dimensions reject the whole profile so the caller can
     * fall back to the known-good default instead of guessing.
     * Unknown pieces, duplicate pad coordinates, duplicate pad ids, duplicate
     * piece assignments, and out-of-bounds pads are dropped instead of throwing.
     *
     * @param {*} raw - Untrusted profile-like data.
     * @returns {object|null} Normalized profile or null when unusable.
     */
    function validatePadProfile(raw) {
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
        const assignedPieces = new Set();
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
                if (PEDAL_PIECE_SET.has(piece)) continue;
                if (!PIECE_SET.has(piece)) continue;
                if (assignedPieces.has(piece)) continue;
                assignedPieces.add(piece);
                pieces.push(piece);
            }
            if (pieces.length === 0) continue;

            occupied.add(coordKey);
            usedPadIds.add(padId);
            pads.push({
                id: padId,
                row,
                col,
                label: sanitizeProfileDisplayText(pad.label, PIECE_LABELS[pieces[0]] || pieces[0].toUpperCase()),
                pieces,
            });
        }
        if (pads.length === 0) return null;

        const fallbacks = Object.create(null);
        const rawFallbacks = raw.fallbacks && typeof raw.fallbacks === 'object' ? raw.fallbacks : {};
        for (const piece of ALL_PIECES) {
            const fallbackPiece = rawFallbacks[piece] || PIECE_FALLBACKS[piece];
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
     * MVP supports kick and hi-hat pedal as separate surfaces. Keeping this
     * separate from pads lets later profiles change foot controls without
     * changing the built-in pad layout schema.
     *
     * @param {*} raw - Untrusted profile-like data.
     * @returns {object|null} Normalized pedal profile or null when unusable.
     */
    function validatePedalProfile(raw) {
        if (!raw || typeof raw !== 'object') return null;
        const rawPedals = Array.isArray(raw.pedals) ? raw.pedals : null;
        if (!rawPedals) return null;

        const pedals = [];
        const assignedPieces = new Set();
        const occupiedSurfaces = new Set();
        for (let i = 0; i < rawPedals.length; i++) {
            const pedal = rawPedals[i];
            if (!pedal || typeof pedal !== 'object') continue;
            const surface = typeof pedal.surface === 'string' ? pedal.surface.trim() : '';
            if (!PEDAL_SURFACE_SET.has(surface)) continue;
            if (occupiedSurfaces.has(surface)) continue;

            const pieces = [];
            const rawPieces = Array.isArray(pedal.pieces) ? pedal.pieces : [];
            for (const piece of rawPieces) {
                if (!PEDAL_PIECE_SET.has(piece)) continue;
                if (assignedPieces.has(piece)) continue;
                assignedPieces.add(piece);
                pieces.push(piece);
            }
            if (pieces.length === 0) continue;

            occupiedSurfaces.add(surface);
            const color = typeof pedal.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(pedal.color)
                ? pedal.color.toLowerCase()
                : (pieces[0] === 'kick' ? '#facc15' : '#22d3ee');
            pedals.push({
                id: sanitizeProfileId(pedal.id, pieces[0].replace(/_/g, '-')),
                surface,
                label: sanitizeProfileDisplayText(pedal.label, PIECE_LABELS[pieces[0]] || pieces[0].toUpperCase()),
                pieces,
                color,
            });
        }
        if (pedals.length === 0) return null;

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
     * surface tokens like pedals do, but accept only pad pieces.
     *
     * @param {*} raw - Untrusted profile-like data.
     * @returns {object|null} Normalized trigger profile or null when unusable.
     */
    function validateTriggerProfile(raw) {
        if (!raw || typeof raw !== 'object') return null;
        const rawTriggers = Array.isArray(raw.triggers) ? raw.triggers : null;
        if (!rawTriggers) return null;

        const triggers = [];
        const assignedPieces = new Set();
        const occupiedSurfaces = new Set();
        const usedTriggerIds = new Set();
        for (let i = 0; i < rawTriggers.length; i++) {
            const trigger = rawTriggers[i];
            if (!trigger || typeof trigger !== 'object') continue;
            const surface = typeof trigger.surface === 'string' ? trigger.surface.trim() : '';
            if (!TRIGGER_SURFACE_SET.has(surface)) continue;
            if (occupiedSurfaces.has(surface)) continue;

            const defaultId = 'trigger-' + (triggers.length + 1);
            const triggerId = sanitizeProfileId(trigger.id, defaultId);
            if (usedTriggerIds.has(triggerId)) continue;

            const pieces = [];
            const rawPieces = Array.isArray(trigger.pieces) ? trigger.pieces : [];
            for (const piece of rawPieces) {
                if (PEDAL_PIECE_SET.has(piece)) continue;
                if (!PIECE_SET.has(piece)) continue;
                if (assignedPieces.has(piece)) continue;
                assignedPieces.add(piece);
                pieces.push(piece);
            }
            if (pieces.length === 0) continue;

            occupiedSurfaces.add(surface);
            usedTriggerIds.add(triggerId);
            const color = typeof trigger.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(trigger.color)
                ? trigger.color.toLowerCase()
                : '#a78bfa';
            triggers.push({
                id: triggerId,
                surface,
                label: sanitizeProfileDisplayText(trigger.label, PIECE_LABELS[pieces[0]] || pieces[0].toUpperCase()),
                pieces,
                color,
            });
        }

        return {
            version: 1,
            id: sanitizeProfileId(raw.id, DEFAULT_TRIGGER_PROFILE.id),
            name: sanitizeProfileDisplayText(raw.name, 'Custom external triggers'),
            triggers,
        };
    }

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
        const padProfileId = readStorageValue(LS_KEYS.padProfileId);
        if (padProfileId === DEFAULT_PAD_PROFILE.id) settings.padProfileId = padProfileId;
        const pedalProfileId = readStorageValue(LS_KEYS.pedalProfileId);
        if (pedalProfileId === DEFAULT_PEDAL_PROFILE.id) settings.pedalProfileId = pedalProfileId;
        const triggerProfileId = readStorageValue(LS_KEYS.triggerProfileId);
        if (triggerProfileId === DEFAULT_TRIGGER_PROFILE.id) settings.triggerProfileId = triggerProfileId;

        const showLabels = readStorageValue(LS_KEYS.showLabels);
        if (showLabels === '1' || showLabels === 'true') settings.showLabels = true;
        else if (showLabels === '0' || showLabels === 'false') settings.showLabels = false;

        const hitGroupWindowMs = readStorageValue(LS_KEYS.hitGroupWindowMs);
        if (hitGroupWindowMs !== null) {
            settings.hitGroupWindowMs = clampNumber(hitGroupWindowMs, 0, 50, DEFAULT_SETTINGS.hitGroupWindowMs);
        }
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
        if (key === 'padProfileId' && value !== DEFAULT_PAD_PROFILE.id) return;
        if (key === 'pedalProfileId' && value !== DEFAULT_PEDAL_PROFILE.id) return;
        if (key === 'triggerProfileId' && value !== DEFAULT_TRIGGER_PROFILE.id) return;
        if (key === 'showLabels') {
            writeStorageValue(LS_KEYS[key], value ? '1' : '0');
            return;
        }
        if (key === 'hitGroupWindowMs') {
            writeStorageValue(LS_KEYS[key], String(clampNumber(value, 0, 50, DEFAULT_SETTINGS.hitGroupWindowMs)));
            return;
        }
        writeStorageValue(LS_KEYS[key], String(value));
    }

    /**
     * Build piece -> pad routing for a pad profile.
     *
     * The returned route preserves the original piece and separately
     * records the fallback `routedPiece`, so rendering can keep labels/variants
     * honest while sharing a pad for pieces such as open/closed hi-hat.
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
        for (const piece of PAD_PIECES) {
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
                routed[piece] = trigger;
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
                routed[piece] = pedal;
            }
        }
        return routed;
    }

    /**
     * Classify a drum-tab hit into the renderer variant used by drum_highway_3d.
     *
     * @param {object} hit - Raw or normalized drum hit.
     * @returns {'ghost'|'flam'|'bell'|'accent'|'normal'}
     */
    function hitVariant(hit) {
        if (hit && hit.g) return 'ghost';
        if (hit && hit.f) return 'flam';
        if (hit && hit.p === 'ride_bell') return 'bell';
        const v = hit && typeof hit.v === 'number' ? hit.v : 100;
        if (v >= 100) return 'accent';
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
     * @returns {{padProfile: object, pedalProfile: object, triggerProfile: object, hitEvents: Array<object>, hitGroups: Array<object>}}
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

        for (const rawHit of hits) {
            const hit = normalizeHit(rawHit);
            if (!hit) continue;
            const pedal = pieceToPedal[hit.piece];
            if (pedal) {
                hitEvents.push({
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
                });
                continue;
            }
            const trigger = pieceToTrigger[hit.piece];
            if (trigger) {
                hitEvents.push({
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
                });
                continue;
            }
            const route = pieceToPad[hit.piece];
            if (!route) continue;
            hitEvents.push({
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
        let surfaceGroup = null;
        let notesGroup = null;
        let labelGroup = null;
        let surfaces = Object.create(null);
        let noteGeometry = null;
        let noteMaterials = new Map();
        let noteMeshPool = [];
        let cachedDrumTab = null;
        let cachedProjection = null;
        let demoProjection = null;
        let activeSurfaceLayoutKey = null;
        let renderCursorProjection = null;
        let renderCursorIndex = 0;
        let renderCursorTime = -Infinity;
        let visibleNoteCount = 0;

        /**
         * Return a monotonic wall-clock time for demo playback.
         *
         * @returns {number} Seconds.
         */
        function nowSec() {
            if (typeof performance !== 'undefined' && performance && typeof performance.now === 'function') {
                return performance.now() / 1000;
            }
            return Date.now() / 1000;
        }

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
         * Hide pooled note meshes before rendering the next frame.
         *
         * Stable geometry and materials are shared and disposed during teardown,
         * so note meshes can be dropped without disposing those resources here.
         *
         * @returns {void}
         */
        function clearTransientNotes() {
            if (!notesGroup) return;
            for (const mesh of noteMeshPool) {
                mesh.visible = false;
            }
            visibleNoteCount = 0;
        }

        /**
         * Return a reusable note mesh for this frame.
         *
         * @param {object} material - Material for the current note variant.
         * @returns {object} Three.js mesh.
         */
        function acquireNoteMesh(material) {
            let mesh = noteMeshPool[visibleNoteCount];
            if (!mesh) {
                mesh = new T.Mesh(noteGeometry, material);
                noteMeshPool.push(mesh);
                notesGroup.add(mesh);
            } else if (mesh.material !== material) {
                mesh.material = material;
            }
            mesh.visible = true;
            visibleNoteCount++;
            return mesh;
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

        /**
         * Return a cached material for note meshes.
         *
         * @param {number} colorHex - Three.js hex color.
         * @param {string} variant - Hit variant such as `normal`, `ghost`, or `accent`.
         * @returns {object} Three.js material.
         */
        function getNoteMaterial(colorHex, variant) {
            const key = String(colorHex) + ':' + String(variant || 'normal');
            if (noteMaterials.has(key)) return noteMaterials.get(key);
            const transparent = variant === 'ghost';
            const material = new T.MeshStandardMaterial({
                color: colorHex,
                emissive: colorHex,
                emissiveIntensity: variant === 'accent' ? 0.85 : 0.55,
                metalness: 0.12,
                roughness: 0.36,
                transparent,
                opacity: transparent ? 0.46 : 0.92,
            });
            noteMaterials.set(key, material);
            return material;
        }

        /**
         * Create a texture-backed sprite label for a pad surface.
         *
         * @param {string} text - Short label text.
         * @param {number} width - Sprite width in world units.
         * @param {number} height - Sprite height in world units.
         * @returns {object|null} Three.js sprite, or null when canvas is unavailable.
         */
        function createLabelSprite(text, width, height) {
            if (typeof document === 'undefined' || !document.createElement) return null;
            const c = document.createElement('canvas');
            c.width = 256;
            c.height = 96;
            const ctx = c.getContext('2d');
            if (!ctx) return null;
            ctx.clearRect(0, 0, c.width, c.height);
            ctx.font = '700 36px system-ui, -apple-system, Segoe UI, sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.lineWidth = 6;
            ctx.strokeStyle = 'rgba(0, 0, 0, 0.82)';
            ctx.fillStyle = SCENE_COLORS.text;
            ctx.strokeText(String(text || '').slice(0, 8), c.width / 2, c.height / 2);
            ctx.fillText(String(text || '').slice(0, 8), c.width / 2, c.height / 2);
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
         * Add receding tunnel guide lines behind one pad surface.
         *
         * @param {number} x - Surface center X.
         * @param {number} y - Surface center Y.
         * @param {number} w - Surface width.
         * @param {number} h - Surface height.
         * @param {object} group - Three.js group receiving the line segments.
         * @returns {void}
         */
        function addTunnelLines(x, y, w, h, group) {
            const front = [
                [x - w / 2, y - h / 2, 0.015],
                [x + w / 2, y - h / 2, 0.015],
                [x + w / 2, y + h / 2, 0.015],
                [x - w / 2, y + h / 2, 0.015],
            ];
            const backY = GRID_CENTER_Y + (y - GRID_CENTER_Y) * TUNNEL_BACK_SCALE;
            const back = [
                [(x - w / 2) * TUNNEL_BACK_SCALE, backY - h * TUNNEL_BACK_SCALE / 2, -TUNNEL_DEPTH],
                [(x + w / 2) * TUNNEL_BACK_SCALE, backY - h * TUNNEL_BACK_SCALE / 2, -TUNNEL_DEPTH],
                [(x + w / 2) * TUNNEL_BACK_SCALE, backY + h * TUNNEL_BACK_SCALE / 2, -TUNNEL_DEPTH],
                [(x - w / 2) * TUNNEL_BACK_SCALE, backY + h * TUNNEL_BACK_SCALE / 2, -TUNNEL_DEPTH],
            ];
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
            });
            group.add(new T.LineSegments(geo, mat));
        }

        /**
         * Add one rectangular render surface and edge outline to the surface group.
         *
         * @param {string} key - Surface id.
         * @param {number} x - Surface center X.
         * @param {number} y - Surface center Y.
         * @param {number} w - Surface width.
         * @param {number} h - Surface height.
         * @param {number} colorHex - Emissive color for hit pulses.
         * @param {number} opacity - Base material opacity.
         * @param {object} group - Three.js group receiving the surface meshes.
         * @returns {object} Surface descriptor used by note placement.
         */
        function addPlaneSurface(key, x, y, w, h, colorHex, opacity, group) {
            const geo = new T.PlaneGeometry(w, h);
            const mat = new T.MeshStandardMaterial({
                color: SCENE_COLORS.pad,
                emissive: colorHex,
                emissiveIntensity: 0.05,
                metalness: 0.1,
                roughness: 0.72,
                side: T.DoubleSide,
                transparent: true,
                opacity,
            });
            const mesh = new T.Mesh(geo, mat);
            mesh.position.set(x, y, 0);
            group.add(mesh);

            const edgeGeo = new T.EdgesGeometry(geo);
            const edgeMat = new T.LineBasicMaterial({
                color: SCENE_COLORS.padEdge,
                transparent: true,
                opacity: 0.74,
            });
            const edges = new T.LineSegments(edgeGeo, edgeMat);
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
                mesh,
                material: mat,
                edgeMaterial: edgeMat,
                baseOpacity: opacity,
                baseEmissiveIntensity: 0.12,
            };
        }

        /**
         * Add one thick ring render surface for external trigger edge zones.
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
                mesh,
                material: mat,
                baseOpacity: opacity,
                baseEmissiveIntensity: 0.16,
            };
        }

        /**
         * Rebuild the stable pad grid, labels, tunnels, and outline surfaces.
         *
         * @param {object} profile - Validated pad profile.
         * @returns {void}
         */
        function buildSurfaceGrid(profile) {
            if (surfaceGroup) {
                disposeObjectTree(surfaceGroup);
                scene.remove(surfaceGroup);
            }
            if (labelGroup) {
                disposeObjectTree(labelGroup);
                scene.remove(labelGroup);
            }
            surfaceGroup = new T.Group();
            labelGroup = new T.Group();
            scene.add(surfaceGroup);
            scene.add(labelGroup);
            surfaces = Object.create(null);
            const layout = buildSurfaceLayout(profile);
            activeSurfaceLayoutKey = layout.layoutKey;

            for (const desc of layout.surfaces) {
                let surface;
                if (desc.shape === 'circle') {
                    surface = addCircleSurface(desc.key, desc.x, desc.y, desc.radius, desc.color, desc.opacity, surfaceGroup);
                } else if (desc.shape === 'ring') {
                    surface = addRingSurface(desc.key, desc.x, desc.y, desc.innerRadius, desc.outerRadius, desc.color, desc.opacity, surfaceGroup);
                } else {
                    surface = addPlaneSurface(desc.key, desc.x, desc.y, desc.w, desc.h, desc.color, desc.opacity, surfaceGroup);
                }
                surfaces[surface.key] = surface;
                if (desc.kind === 'pad') {
                    addTunnelLines(desc.x, desc.y, desc.w, desc.h, surfaceGroup);
                    const label = createLabelSprite(desc.pad.label, PAD_W * 0.58, PAD_H * 0.26);
                    if (label) {
                        label.position.set(desc.x, desc.y, 0.08);
                        labelGroup.add(label);
                    }
                }
            }
        }

        /**
         * Create the base Three.js scene, camera, lights, floor, and surface grid.
         *
         * @returns {void}
         */
        function initScene() {
            scene = new T.Scene();
            scene.background = new T.Color(SCENE_COLORS.clear);
            scene.fog = new T.Fog(SCENE_COLORS.fog, 12, 34);
            camera = new T.PerspectiveCamera(44, 1, 0.1, 80);
            camera.position.set(0, 2.8, 7.4);
            camera.lookAt(0, GRID_CENTER_Y, -7);

            const ambient = new T.AmbientLight(0x7c8ca8, 0.48);
            const key = new T.DirectionalLight(0xffffff, 1.15);
            key.position.set(-3, 6, 5);
            const rim = new T.DirectionalLight(0x67e8f9, 0.65);
            rim.position.set(3, 3, -6);
            scene.add(ambient, key, rim);

            const floor = new T.Mesh(
                new T.PlaneGeometry(20, 42),
                new T.MeshStandardMaterial({
                    color: SCENE_COLORS.floor,
                    roughness: 0.85,
                    metalness: 0.06,
                })
            );
            floor.rotation.x = -Math.PI / 2;
            floor.position.set(0, -0.05, -9);
            scene.add(floor);

            notesGroup = new T.Group();
            scene.add(notesGroup);
            noteGeometry = new T.BoxGeometry(1, 1, 0.1);
            buildSurfaceGrid(clonePadProfile(DEFAULT_PAD_PROFILE));
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
         * Return projected hit events for the current bundle or demo pattern.
         *
         * The real chart projection is cached by drum-tab object identity.
         *
         * @param {object|null} bundle - Host render bundle.
         * @returns {object|null} Projection returned by `projectDrumTab`.
         */
        function projectionForBundle(bundle) {
            const drumTab = bundle && bundle.drumTab;
            if (drumTab && Array.isArray(drumTab.hits) && drumTab.hits.length > 0) {
                if (cachedDrumTab !== drumTab) {
                    const settings = readSettings();
                    cachedDrumTab = drumTab;
                    cachedProjection = projectDrumTab(drumTab, {
                        hitGroupWindowSec: settings.hitGroupWindowMs / 1000,
                    });
                    buildSurfaceGrid(cachedProjection.padProfile);
                }
                return cachedProjection;
            }
            cachedDrumTab = null;
            cachedProjection = null;
            if (!demoProjection) {
                demoProjection = projectDrumTab({
                    hits: [
                        { t: 0.00, p: 'hh_closed', v: 88 },
                        { t: 0.00, p: 'kick', v: 112 },
                        { t: 0.50, p: 'snare', v: 110 },
                        { t: 1.00, p: 'hh_open', v: 72 },
                        { t: 1.00, p: 'tom_hi', v: 96 },
                        { t: 1.50, p: 'snare_xstick', v: 78 },
                        { t: 2.00, p: 'crash_l', v: 118 },
                        { t: 2.00, p: 'kick', v: 118 },
                        { t: 2.50, p: 'tom_mid', v: 92 },
                        { t: 3.00, p: 'ride_bell', v: 92 },
                        { t: 3.50, p: 'tom_floor', v: 108 },
                        { t: 3.50, p: 'hh_pedal', v: 92 },
                    ],
                }, { hitGroupWindowSec: DEFAULT_SETTINGS.hitGroupWindowMs / 1000 });
            }
            if (activeSurfaceLayoutKey !== padProfileLayoutKey(demoProjection.padProfile)) {
                buildSurfaceGrid(demoProjection.padProfile);
            }
            return demoProjection;
        }

        /**
         * Restore surface materials and scales before applying this frame's pulses.
         *
         * @returns {void}
         */
        function resetSurfacePulses() {
            for (const id of Object.keys(surfaces)) {
                const surface = surfaces[id];
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
         * Add a visible note mesh for one event at a time offset from the hit plane.
         *
         * @param {object} event - Projected hit event.
         * @param {number} dt - Seconds until hit time; positive means upstream.
         * @returns {void}
         */
        function placeNote(event, dt) {
            const surface = surfaceForEvent(event);
            if (!surface || !noteGeometry || !notesGroup) return;
            const z = -dt * NOTE_SPEED;
            const progress = Math.max(0, Math.min(1, (z + TUNNEL_DEPTH) / TUNNEL_DEPTH));
            const backX = surface.x * TUNNEL_BACK_SCALE;
            const backY = GRID_CENTER_Y + (surface.y - GRID_CENTER_Y) * TUNNEL_BACK_SCALE;
            const x = backX + (surface.x - backX) * progress;
            const y = backY + (surface.y - backY) * progress;
            const color = eventColorForEvent(event);
            const mesh = acquireNoteMesh(getNoteMaterial(color, event.variant));
            const size = 0.55 + progress * 0.45;
            const accent = event.variant === 'accent' ? 1.12 : 1;
            const ghost = event.variant === 'ghost' ? 0.78 : 1;
            const w = surface.w * (event.type === 'pad' ? 0.72 : 0.92) * size * accent;
            const h = surface.h * (event.type === 'pad' ? 0.52 : 0.86) * size * ghost;
            mesh.position.set(x, y, z);
            mesh.scale.set(w, Math.max(0.045, h), event.variant === 'flam' ? 0.08 : 0.11);

            if (event.variant === 'flam') {
                const grace = acquireNoteMesh(getNoteMaterial(color, 'ghost'));
                grace.position.set(x - surface.w * 0.14 * size, y + surface.h * 0.12 * size, z + 0.04);
                grace.scale.set(w * 0.44, Math.max(0.035, h * 0.5), 0.07);
            }
        }

        /**
         * Apply a short surface pulse when an event is near the hit plane.
         *
         * @param {object} event - Projected hit event.
         * @param {number} dt - Seconds from hit time.
         * @returns {void}
         */
        function applyEventPulse(event, dt) {
            const surface = surfaceForEvent(event);
            if (!surface) return;
            const pulse = Math.max(0, 1 - Math.abs(dt) / HIT_PULSE_SEC);
            if (pulse <= 0) return;
            const color = eventColorForEvent(event);
            surface.material.emissive.setHex(color);
            surface.material.emissiveIntensity = Math.max(surface.material.emissiveIntensity || 0, 0.18 + pulse * 1.4);
            surface.material.opacity = Math.max(surface.material.opacity || 0, 0.52 + pulse * 0.42);
            const scale = 1 + pulse * (event.type === 'pad' ? 0.045 : 0.09);
            surface.mesh.scale.set(scale, scale, 1);
        }

        /**
         * Rebuild visible note meshes and surface pulses for the current frame.
         *
         * @param {object|null} bundle - Host render bundle.
         * @returns {void}
         */
        function renderEvents(bundle) {
            if (!notesGroup) return;
            clearTransientNotes();
            const projection = projectionForBundle(bundle);
            resetSurfacePulses();
            if (!projection) return;

            const realHits = bundle && bundle.drumTab && Array.isArray(bundle.drumTab.hits) && bundle.drumTab.hits.length > 0;
            const t = realHits && Number.isFinite(bundle.currentTime)
                ? bundle.currentTime
                : nowSec() % DEMO_PATTERN_SEC;
            const events = projection.hitEvents;
            if (realHits) {
                const startIndex = visibleEventStartIndex(projection, t);
                for (let i = startIndex; i < events.length; i++) {
                    const event = events[i];
                    const dt = event.t - t;
                    if (dt > NOTE_AHEAD_SEC) break;
                    if (dt < -NOTE_BEHIND_SEC) continue;
                    placeNote(event, dt);
                    applyEventPulse(event, dt);
                }
                return;
            }

            renderCursorProjection = null;
            renderCursorIndex = 0;
            renderCursorTime = -Infinity;
            for (let cycle = -1; cycle <= 1; cycle++) {
                const base = cycle * DEMO_PATTERN_SEC;
                for (const event of events) {
                    const dt = event.t + base - t;
                    if (dt > NOTE_AHEAD_SEC || dt < -NOTE_BEHIND_SEC) continue;
                    placeNote(event, dt);
                    applyEventPulse(event, dt);
                }
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
            noteMaterials = new Map();
            canvas = null;
            lastBundle = null;
            scene = null;
            camera = null;
            renderer = null;
            surfaceGroup = null;
            notesGroup = null;
            labelGroup = null;
            surfaces = Object.create(null);
            noteGeometry = null;
            noteMeshPool = [];
            cachedDrumTab = null;
            cachedProjection = null;
            renderCursorProjection = null;
            renderCursorIndex = 0;
            renderCursorTime = -Infinity;
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
                    } catch (err) {
                        console.error('[Multipad-Hwy3D] WebGL2 init failed:', err);
                        teardown();
                        return;
                    }
                    initScene();
                    applySize(canvas.clientWidth || canvas.width || lastWidth, canvas.clientHeight || canvas.height || lastHeight);
                    ready = true;
                    instance.draw(lastBundle);
                }).catch(() => {
                    if (!destroyed) teardown();
                });
            },

            draw(bundle) {
                if (destroyed) return;
                lastBundle = bundle || lastBundle;
                if (!ready || !renderer || !scene || !camera) return;
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
                    projectedHits: cachedProjection ? cachedProjection.hitEvents.length : 0,
                    visibleNotes: visibleNoteCount,
                };
            },
        };

        return instance;
    }

    createFactory.contextType = CONTEXT_TYPE;
    createFactory.matchesArrangement = matchesArrangement;
    createFactory.__test = {
        pluginId: PLUGIN_ID,
        contextType: CONTEXT_TYPE,
        matchesArrangement,
        ALL_PIECES: ALL_PIECES.slice(),
        PAD_PIECES: PAD_PIECES.slice(),
        PEDAL_PIECES: PEDAL_PIECES.slice(),
        PEDAL_SURFACES: PEDAL_SURFACES.slice(),
        TRIGGER_SURFACES: TRIGGER_SURFACES.slice(),
        PIECE_LABELS: Object.assign({}, PIECE_LABELS),
        DEFAULT_PAD_PROFILE: clonePadProfile(DEFAULT_PAD_PROFILE),
        DEFAULT_PEDAL_PROFILE: clonePedalProfile(DEFAULT_PEDAL_PROFILE),
        DEFAULT_TRIGGER_PROFILE: cloneTriggerProfile(DEFAULT_TRIGGER_PROFILE),
        DEFAULT_SETTINGS: Object.assign({}, DEFAULT_SETTINGS),
        validatePadProfile,
        validatePedalProfile,
        validateTriggerProfile,
        colorHexFromCss,
        readSettings,
        writeSetting,
        buildPieceToPadMap,
        buildPieceToPedalMap,
        buildPieceToTriggerMap,
        buildSurfaceLayout,
        padProfileLayoutKey,
        lowerBoundHitEvents,
        hitVariant,
        normalizeHit,
        groupHitEvents,
        projectDrumTab,
        liveInstanceCount() {
            return liveInstances.size;
        },
    };

    window.feedBackViz_multipad_highway_3d = createFactory;
    window.__multipadH3dTest = {
        getState() {
            return {
                pluginId: PLUGIN_ID,
                contextType: CONTEXT_TYPE,
                liveInstances: liveInstances.size,
                autoClaims: matchesArrangement({ has_drum_tab: true, arrangement: 'Drums' }),
            };
        },
    };
})();
