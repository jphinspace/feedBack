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

