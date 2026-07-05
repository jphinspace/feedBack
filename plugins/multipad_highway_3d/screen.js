// Multipad Highway 3D visualization plugin.
//
// Phase 3 data pipeline: validatePadProfile/validatePedalProfile/
// validateTriggerProfile normalize the configurable surface,
// buildPieceToPadMap/buildPieceToPedalMap/buildPieceToTriggerMap route drum
// pieces, and projectDrumTab/groupHitEvents prepare grouped hits for the
// upcoming 3D renderer.

(function () {
    'use strict';

    /** Stable plugin id; must match plugin.json and the feedBackViz global name. */
    const PLUGIN_ID = 'multipad_highway_3d';
    /**
     * Phase 3 still renders as a no-op 2D canvas. Phase 4 should switch this
     * to `webgl2` when the real Three.js renderer lands.
     */
    const CONTEXT_TYPE = '2d';
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
    /** Pieces that render through pedal indicators instead of occupying pads. */
    const PEDAL_PIECES = Object.freeze(['kick', 'hh_pedal']);
    const PEDAL_PIECE_SET = new Set(PEDAL_PIECES);
    /** Non-pedal pieces that may route to built-in pads or external trigger indicators. */
    const PAD_PIECES = ALL_PIECES.filter(piece => !PEDAL_PIECE_SET.has(piece));
    /** MVP pedal indicator tokens. Phase 4 maps these to grid-outline regions. */
    const PEDAL_INDICATORS = Object.freeze(['outline-top', 'outline-bottom']);
    const PEDAL_INDICATOR_SET = new Set(PEDAL_INDICATORS);
    /** MVP external-trigger indicator tokens for off-grid pad inputs. */
    const TRIGGER_INDICATORS = Object.freeze(['outline-left', 'outline-right', 'symbol-left', 'symbol-right']);
    const TRIGGER_INDICATOR_SET = new Set(TRIGGER_INDICATORS);
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
     * Built-in pedal profile. Pedal pieces stay outside the pads and render as
     * indicators on the active pad grid: hi-hat pedal on top, kick on bottom.
     */
    const DEFAULT_PEDAL_PROFILE = Object.freeze({
        version: 1,
        id: 'generic-pedals',
        name: 'Generic pedals',
        pedals: Object.freeze([
            Object.freeze({
                id: 'hh-pedal',
                indicator: 'outline-top',
                label: 'HHp',
                pieces: Object.freeze(['hh_pedal']),
                color: '#22d3ee',
            }),
            Object.freeze({
                id: 'kick',
                indicator: 'outline-bottom',
                label: 'KICK',
                pieces: Object.freeze(['kick']),
                color: '#facc15',
            }),
        ]),
    });

    /**
     * Built-in external trigger profile. External pad triggers are off-grid
     * inputs, so they render through indicators instead of occupying built-in
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
                indicator: pedal.indicator,
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
                indicator: trigger.indicator,
                label: trigger.label,
                pieces: trigger.pieces.slice(),
                color: trigger.color,
            })),
        };
    }

    /**
     * Validate and normalize a pad layout.
     *
     * The profile accepts explicit m x n layouts and drum piece ids, but rejects
     * pedal pieces because the pedal profile owns pedal indicator rendering.
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
            const target = rawFallbacks[piece] || PIECE_FALLBACKS[piece];
            if (PEDAL_PIECE_SET.has(piece) || PEDAL_PIECE_SET.has(target)) continue;
            if (!PIECE_SET.has(piece) || !PIECE_SET.has(target)) continue;
            fallbacks[piece] = target;
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
     * MVP supports kick and hi-hat pedal as separate indicators. Keeping this
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
        const occupiedIndicators = new Set();
        for (let i = 0; i < rawPedals.length; i++) {
            const pedal = rawPedals[i];
            if (!pedal || typeof pedal !== 'object') continue;
            const indicator = typeof pedal.indicator === 'string' ? pedal.indicator.trim() : '';
            if (!PEDAL_INDICATOR_SET.has(indicator)) continue;
            if (occupiedIndicators.has(indicator)) continue;

            const pieces = [];
            const rawPieces = Array.isArray(pedal.pieces) ? pedal.pieces : [];
            for (const piece of rawPieces) {
                if (!PEDAL_PIECE_SET.has(piece)) continue;
                if (assignedPieces.has(piece)) continue;
                assignedPieces.add(piece);
                pieces.push(piece);
            }
            if (pieces.length === 0) continue;

            occupiedIndicators.add(indicator);
            const color = typeof pedal.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(pedal.color)
                ? pedal.color.toLowerCase()
                : (pieces[0] === 'kick' ? '#facc15' : '#22d3ee');
            pedals.push({
                id: sanitizeProfileId(pedal.id, pieces[0].replace(/_/g, '-')),
                indicator,
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
     * indicator tokens like pedals do, but accept only pad pieces.
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
        const occupiedIndicators = new Set();
        const usedTriggerIds = new Set();
        for (let i = 0; i < rawTriggers.length; i++) {
            const trigger = rawTriggers[i];
            if (!trigger || typeof trigger !== 'object') continue;
            const indicator = typeof trigger.indicator === 'string' ? trigger.indicator.trim() : '';
            if (!TRIGGER_INDICATOR_SET.has(indicator)) continue;
            if (occupiedIndicators.has(indicator)) continue;

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

            occupiedIndicators.add(indicator);
            usedTriggerIds.add(triggerId);
            const color = typeof trigger.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(trigger.color)
                ? trigger.color.toLowerCase()
                : '#a78bfa';
            triggers.push({
                id: triggerId,
                indicator,
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
     * @returns {object} Map of piece id to { targetType, pad, routedPiece }.
     */
    function buildPieceToPadMap(padProfile) {
        const profile = validatePadProfile(padProfile) || clonePadProfile(DEFAULT_PAD_PROFILE);
        const direct = Object.create(null);
        for (const pad of profile.pads) {
            for (const piece of pad.pieces) {
                direct[piece] = { targetType: 'pad', pad };
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
     * Build piece -> external trigger indicator routing for a trigger profile.
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
     * Build piece -> pedal indicator routing for a pedal profile.
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
     * pad, trigger, or fallback target as closed hi-hat.
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
     * indicators. Hit events are annotated with `hitGroupId` for render-time FX.
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
                    triggerIndicators: [],
                    pedalIndicators: [],
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
                if (hitEvent.indicator && !group.pedalIndicators.includes(hitEvent.indicator)) {
                    group.pedalIndicators.push(hitEvent.indicator);
                }
            }
            if (hitEvent.type === 'pad' && !group.padIds.includes(hitEvent.padId)) {
                group.padIds.push(hitEvent.padId);
            }
            if (hitEvent.type === 'trigger' && !group.triggerIds.includes(hitEvent.triggerId)) {
                group.triggerIds.push(hitEvent.triggerId);
            }
            if (hitEvent.type === 'trigger' && hitEvent.indicator && !group.triggerIndicators.includes(hitEvent.indicator)) {
                group.triggerIndicators.push(hitEvent.indicator);
            }
        }
        return groups;
    }

    /**
     * Project a drum tab into multipad hit events.
     *
     * This is the Phase 3 bridge from host chart data to renderer-ready data:
     * hits become pad, external-trigger, or pedal indicator events, sorted by
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
                    indicator: pedal.indicator,
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
                    indicator: trigger.indicator,
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
     * Until Phase 4 has a visible/useful renderer this deliberately returns
     * false so the plugin can be selected manually without stealing drum songs
     * from `drum_highway_3d`.
     *
     * @param {object} _songInfo - Host song/arrangement metadata.
     * @returns {boolean}
     */
    function matchesArrangement(_songInfo) {
        // The pre-Phase-4 renderer is intentionally no-op, so Auto mode should not
        // select it yet. Manual picker selection still exercises the lifecycle.
        return false;
    }

    /**
     * Build one renderer instance for the host setRenderer lifecycle.
     *
     * The Phase 3 instance only clears the shared canvas, but it already keeps
     * state per instance so Phase 4 can grow into split-screen-safe WebGL
     * rendering without changing the factory contract.
     *
     * @returns {{contextType: string, init: Function, draw: Function, resize: Function, destroy: Function}}
     */
    function createFactory() {
        let canvas = null;
        let ctx = null;
        let lastBundle = null;
        let lastWidth = 0;
        let lastHeight = 0;
        let destroyed = false;

        /** Clear whatever a previous renderer left on the shared canvas. */
        function clearCanvas() {
            if (!ctx || !canvas || typeof ctx.clearRect !== 'function') return;
            const w = canvas.width || canvas.clientWidth || lastWidth || 0;
            const h = canvas.height || canvas.clientHeight || lastHeight || 0;
            if (w > 0 && h > 0) ctx.clearRect(0, 0, w, h);
        }

        const instance = {
            contextType: CONTEXT_TYPE,

            init(nextCanvas, bundle) {
                destroyed = false;
                canvas = nextCanvas || null;
                lastBundle = bundle || null;
                ctx = null;

                if (canvas && typeof canvas.getContext === 'function') {
                    ctx = canvas.getContext(CONTEXT_TYPE);
                }
                liveInstances.add(instance);
                clearCanvas();
            },

            draw(bundle) {
                if (destroyed) return;
                lastBundle = bundle || lastBundle;
                clearCanvas();
            },

            resize(width, height) {
                lastWidth = Number.isFinite(width) ? Math.max(0, width) : 0;
                lastHeight = Number.isFinite(height) ? Math.max(0, height) : 0;
                clearCanvas();
            },

            destroy() {
                clearCanvas();
                liveInstances.delete(instance);
                destroyed = true;
                canvas = null;
                ctx = null;
                lastBundle = null;
                lastWidth = 0;
                lastHeight = 0;
            },

            __probe() {
                return {
                    pluginId: PLUGIN_ID,
                    contextType: CONTEXT_TYPE,
                    initialized: !!canvas && !destroyed,
                    width: lastWidth,
                    height: lastHeight,
                    hasBundle: !!lastBundle,
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
        PEDAL_INDICATORS: PEDAL_INDICATORS.slice(),
        TRIGGER_INDICATORS: TRIGGER_INDICATORS.slice(),
        PIECE_LABELS: Object.assign({}, PIECE_LABELS),
        DEFAULT_PAD_PROFILE: clonePadProfile(DEFAULT_PAD_PROFILE),
        DEFAULT_PEDAL_PROFILE: clonePedalProfile(DEFAULT_PEDAL_PROFILE),
        DEFAULT_TRIGGER_PROFILE: cloneTriggerProfile(DEFAULT_TRIGGER_PROFILE),
        DEFAULT_SETTINGS: Object.assign({}, DEFAULT_SETTINGS),
        validatePadProfile,
        validatePedalProfile,
        validateTriggerProfile,
        readSettings,
        writeSetting,
        buildPieceToPadMap,
        buildPieceToPedalMap,
        buildPieceToTriggerMap,
        hitVariant,
        normalizeHit,
        groupHitEvents,
        projectDrumTab,
        liveInstanceCount() {
            return liveInstances.size;
        },
    };

    window.slopsmithViz_multipad_highway_3d = createFactory;
    window.feedBackViz_multipad_highway_3d = createFactory;
    window.__multipadH3dTest = {
        getState() {
            return {
                pluginId: PLUGIN_ID,
                contextType: CONTEXT_TYPE,
                liveInstances: liveInstances.size,
                autoClaims: false,
            };
        },
    };
})();
