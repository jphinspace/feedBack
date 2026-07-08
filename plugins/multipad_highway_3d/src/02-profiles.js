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
        if (surfaces.has('external-left-center') || surfaces.has('external-left-edge')) {
            slots.push({ id: 'trigger-1', zones: surfaces.has('external-left-edge') ? 2 : 1 });
        }
        if (surfaces.has('external-right-center') || surfaces.has('external-right-edge')) {
            slots.push({ id: 'trigger-2', zones: surfaces.has('external-right-edge') ? 2 : 1 });
        }
        return slots;
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
     * @param {object} [pedalProfile] - Validated or raw pedal profile.
     * @param {object} [triggerProfile] - Validated or raw trigger profile.
     * @returns {{layoutKey: string, rows: number, cols: number, gridW: number, gridH: number, surfaces: Array<object>}}
     */
    function buildSurfaceLayout(profile, pedalProfile, triggerProfile) {
        const valid = validatePadProfile(profile) || clonePadProfile(DEFAULT_PAD_PROFILE);
        const pedals = validatePedalProfile(pedalProfile) || clonePedalProfile(DEFAULT_PEDAL_PROFILE);
        const triggers = validateTriggerProfile(triggerProfile) || cloneTriggerProfile(DEFAULT_TRIGGER_PROFILE);
        const activeSurfaceColor = Object.create(null);
        for (const pedal of pedals.pedals) {
            if (pedal.pieces.length > 0 && activeSurfaceColor[pedal.surface] == null) {
                const profileColor = colorHexFromCss(pedal.color);
                activeSurfaceColor[pedal.surface] = profileColor !== null
                    ? profileColor
                    : (PIECE_COLORS[pedal.pieces[0]] || SCENE_COLORS.surface);
            }
        }
        for (const trigger of triggers.triggers) {
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
            });
        }

        const topY = GRID_CENTER_Y + gridH / 2 + 0.24;
        const bottomY = GRID_CENTER_Y - gridH / 2 - 0.24;
        const sideX = gridW / 2 + 0.25;
        const externalPadRadius = EXTERNAL_TRIGGER_PAD_DIAMETER / 2;
        const externalPadCenterRadius = externalPadRadius - EXTERNAL_TRIGGER_PAD_EDGE_WIDTH;
        const externalPadX = gridW / 2 + 0.25 + 0.11 / 2 + externalPadRadius + 0.22;
        function controlledSurface(key, activeOpacity, inactiveOpacity) {
            const active = activeSurfaceColor[key] != null;
            return {
                active,
                color: active ? activeSurfaceColor[key] : SCENE_COLORS.inactiveSurface,
                opacity: active ? activeOpacity : inactiveOpacity,
            };
        }
        const top = controlledSurface('outline-top', 0.2, 0.08);
        const bottom = controlledSurface('outline-bottom', 0.22, 0.08);
        const left = controlledSurface('outline-left', 0.16, 0.06);
        const right = controlledSurface('outline-right', 0.16, 0.06);
        const leftCenter = controlledSurface('external-left-center', 0.48, 0.16);
        const leftEdge = controlledSurface('external-left-edge', 0.82, 0.18);
        const rightCenter = controlledSurface('external-right-center', 0.48, 0.16);
        const rightEdge = controlledSurface('external-right-edge', 0.82, 0.18);
        surfaces.push(
            { key: 'outline-top', kind: 'pedal-outline', shape: 'plane', x: 0, y: topY, w: gridW, h: PEDAL_OUTLINE_H, color: top.color, active: top.active, opacity: top.opacity },
            { key: 'outline-bottom', kind: 'pedal-outline', shape: 'plane', x: 0, y: bottomY, w: gridW, h: PEDAL_OUTLINE_H, color: bottom.color, active: bottom.active, opacity: bottom.opacity },
            { key: 'outline-left', kind: 'trigger-outline', shape: 'plane', x: -sideX, y: GRID_CENTER_Y, w: 0.11, h: gridH, color: left.color, active: left.active, opacity: left.opacity },
            { key: 'outline-right', kind: 'trigger-outline', shape: 'plane', x: sideX, y: GRID_CENTER_Y, w: 0.11, h: gridH, color: right.color, active: right.active, opacity: right.opacity },
            { key: 'external-left-center', kind: 'external-trigger-center', shape: 'circle', x: -externalPadX, y: GRID_CENTER_Y, w: externalPadCenterRadius * 2, h: externalPadCenterRadius * 2, radius: externalPadCenterRadius, color: leftCenter.color, active: leftCenter.active, opacity: leftCenter.opacity },
            { key: 'external-left-edge', kind: 'external-trigger-edge', shape: 'ring', x: -externalPadX, y: GRID_CENTER_Y, w: EXTERNAL_TRIGGER_PAD_DIAMETER, h: EXTERNAL_TRIGGER_PAD_DIAMETER, innerRadius: externalPadCenterRadius, outerRadius: externalPadRadius, color: leftEdge.color, active: leftEdge.active, opacity: leftEdge.opacity },
            { key: 'external-right-center', kind: 'external-trigger-center', shape: 'circle', x: externalPadX, y: GRID_CENTER_Y, w: externalPadCenterRadius * 2, h: externalPadCenterRadius * 2, radius: externalPadCenterRadius, color: rightCenter.color, active: rightCenter.active, opacity: rightCenter.opacity },
            { key: 'external-right-edge', kind: 'external-trigger-edge', shape: 'ring', x: externalPadX, y: GRID_CENTER_Y, w: EXTERNAL_TRIGGER_PAD_DIAMETER, h: EXTERNAL_TRIGGER_PAD_DIAMETER, innerRadius: externalPadCenterRadius, outerRadius: externalPadRadius, color: rightEdge.color, active: rightEdge.active, opacity: rightEdge.opacity }
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
     * The profile accepts explicit m x n layouts and drum piece ids, but rejects
     * pedal pieces because the pedal profile owns pedal surface rendering.
     * Invalid top-level dimensions reject the whole profile so the caller can
     * fall back to the known-good default instead of guessing.
     * Unknown pieces, duplicate pad coordinates, duplicate pad ids, duplicate
     * piece assignments, and out-of-bounds pads are dropped instead of throwing.
     * Pads with no assigned pieces remain valid inactive pads so the settings
     * UI and 3D highway can show them grayed out.
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
            occupied.add(coordKey);
            usedPadIds.add(padId);
            const color = typeof pad.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(pad.color)
                ? pad.color.toLowerCase()
                : (pieces[0] ? ('#' + (PIECE_COLORS[pieces[0]] || SCENE_COLORS.surface).toString(16).padStart(6, '0')) : '#2d3748');
            pads.push({
                id: padId,
                row,
                col,
                label: sanitizeProfileDisplayText(pad.label, pieces[0] ? (PIECE_LABELS[pieces[0]] || pieces[0].toUpperCase()) : ''),
                pieces,
                color,
            });
        }
        if (pads.length === 0) return null;

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
     * MVP supports kick and hi-hat pedal as separate surfaces. Keeping this
     * separate from pads lets later profiles change foot controls without
     * changing the built-in pad layout schema.
     * Pedals with no assigned pieces remain valid inactive pedals. Duplicate
     * pedal pieces are allowed so two physical pedals can both map to kick.
     *
     * @param {*} raw - Untrusted profile-like data.
     * @returns {object|null} Normalized pedal profile or null when unusable.
     */
    function validatePedalProfile(raw) {
        if (!raw || typeof raw !== 'object') return null;
        const rawPedals = Array.isArray(raw.pedals) ? raw.pedals : null;
        if (!rawPedals) return null;

        const pedals = [];
        for (let i = 0; i < rawPedals.length; i++) {
            if (pedals.length >= 2) break;
            const pedal = rawPedals[i];
            if (!pedal || typeof pedal !== 'object') continue;

            const pieces = [];
            const rawPieces = Array.isArray(pedal.pieces) ? pedal.pieces : [];
            for (const piece of rawPieces) {
                if (!PEDAL_PIECE_SET.has(piece)) continue;
                if (pieces.includes(piece)) continue;
                pieces.push(piece);
                break;
            }
            const defaultPiece = pieces[0] || (i === 0 ? 'hh_pedal' : 'kick');
            const requestedSurface = typeof pedal.surface === 'string' ? pedal.surface.trim() : '';
            const surface = PEDAL_SURFACE_SET.has(requestedSurface)
                ? requestedSurface
                : (defaultPiece === 'hh_pedal' ? 'outline-top' : 'outline-bottom');
            const color = typeof pedal.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(pedal.color)
                ? pedal.color.toLowerCase()
                : ('#' + (PIECE_COLORS[defaultPiece] || SCENE_COLORS.inactiveSurface).toString(16).padStart(6, '0'));
            pedals.push({
                id: sanitizeProfileId(pedal.id, 'pedal-' + (i + 1)),
                surface,
                label: sanitizeProfileDisplayText(pedal.label, pieces[0] ? (PIECE_LABELS[pieces[0]] || pieces[0].toUpperCase()) : ''),
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
     * surface tokens like pedals do, but accept only pad pieces. Trigger zones
     * with no assigned pieces remain valid inactive surfaces.
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
            if (triggers.length >= 4) break;
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
            occupiedSurfaces.add(surface);
            usedTriggerIds.add(triggerId);
            const color = typeof trigger.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(trigger.color)
                ? trigger.color.toLowerCase()
                : ('#' + (pieces[0] ? (PIECE_COLORS[pieces[0]] || 0xa78bfa) : SCENE_COLORS.inactiveSurface).toString(16).padStart(6, '0'));
            triggers.push({
                id: triggerId,
                surface,
                label: sanitizeProfileDisplayText(trigger.label, pieces[0] ? (PIECE_LABELS[pieces[0]] || pieces[0].toUpperCase()) : ''),
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
            triggerSlots.push({ id, zones: clampNumber(slot.zones, 1, 2, 1) >= 2 ? 2 : 1 });
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

        const showLabels = readStorageValue(LS_KEYS.showLabels);
        if (showLabels === '1' || showLabels === 'true') settings.showLabels = true;
        else if (showLabels === '0' || showLabels === 'false') settings.showLabels = false;
        for (const key of ['timingColors', 'hitSparks', 'cinematicLighting']) {
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

    function validateMultipadProfile(raw) {
        if (!raw || typeof raw !== 'object') return null;
        const padProfile = validatePadProfile(raw.padProfile);
        const pedalProfile = validatePedalProfile(raw.pedalProfile);
        const triggerProfile = validateTriggerProfile(raw.triggerProfile);
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
        return {
            version: 1,
            id: pad.id,
            name: pad.name,
            padProfile: pad,
            pedalProfile: clonePedalProfile(DEFAULT_PEDAL_PROFILE),
            triggerProfile: cloneTriggerProfile(DEFAULT_TRIGGER_PROFILE),
        };
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

