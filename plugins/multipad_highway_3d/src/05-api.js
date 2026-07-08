    // ---------------------------------------------------------------------
    // Public and Test APIs
    // ---------------------------------------------------------------------

    function createTestApi() {
        return {
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
            DEFAULT_PROFILE: cloneMultipadProfile(DEFAULT_PROFILE),
            BUILTIN_PAD_PROFILE_IDS: Object.keys(BUILTIN_PAD_PROFILES),
            validatePadProfile,
            validatePedalProfile,
            validateTriggerProfile,
            validateMultipadProfile,
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
            lowerBoundHitEvents,
            normalizeTimingStatus,
            hitVariant,
            normalizeHit,
            groupHitEvents,
            projectDrumTab,
            liveInstanceCount() {
                return liveInstances.size;
            },
        };
    }

    function installSettingsGlobals(target) {
        target.multipadH3dGetProfile = function () {
            return cloneMultipadProfile(readMultipadProfile());
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
        target.multipadH3dGetPadPieces = function () {
            return PAD_PIECES.slice();
        };
        target.multipadH3dGetPedalPieces = function () {
            return PEDAL_PIECES.slice();
        };
        target.multipadH3dGetPieceLabels = function () {
            return Object.assign({}, PIECE_LABELS);
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
