const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createThreeStub } = require('./three-stub');
const { createDomStub } = require('./dom-stub');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const PLUGIN_DIR = path.join(ROOT, 'plugins', 'multipad_highway_3d');

function loadFactoryHarness(options = {}) {
    const window = {
        console,
    };
    if (options.localStorage) window.localStorage = options.localStorage;
    if (options.standardDrumHighway) window.feedBackViz_drum_highway_3d = function () {};
    if (options.document) window.document = options.document;
    if (options.feedBack) window.feedBack = options.feedBack;
    // Always available so a test can drive a real init()/draw() cycle by
    // passing a fake canvas - see "renderer builds a real scene..." below.
    // Harmless for tests that never call init() with a non-null canvas
    // (init() returns before ever touching Three for a null canvas, which
    // is what the plain lifecycle test below exercises).
    window.__multipadH3dThree = createThreeStub();
    window.window = window;
    window.globalThis = window;
    const context = vm.createContext(window);
    const src = fs.readFileSync(path.join(PLUGIN_DIR, 'screen.js'), 'utf8');
    vm.runInContext(src, context, { filename: 'screen.js' });
    return window.feedBackViz_multipad_highway_3d;
}

function loadFactory() {
    return loadFactoryHarness();
}

/**
 * A canvas stand-in with just the fields `applySize()`/`init()` read.
 * Three itself is faked (see three-stub.js), so nothing ever calls
 * `.getContext()` on this - the real WebGLRenderer would, ours doesn't.
 */
function fakeCanvas(width = 800, height = 600) {
    return { clientWidth: width, clientHeight: height, width, height };
}

/** Flush both the microtask queue and one macrotask turn - enough for
 * init()'s `loadThree().then(...)` chain (already-resolved promise, fully
 * synchronous callback body) to finish before assertions run. */
function flushAsync() {
    return new Promise(resolve => setTimeout(resolve, 0));
}

function loadFactoryWithStorage(entries = {}, extraOptions = {}) {
    const store = new Map(Object.entries(entries));
    const factory = loadFactoryHarness({
        ...extraOptions,
        localStorage: {
            getItem(key) {
                return store.has(key) ? store.get(key) : null;
            },
            setItem(key, value) {
                store.set(key, String(value));
            },
        },
    });
    return { factory, store };
}

function plain(value) {
    return JSON.parse(JSON.stringify(value));
}

test('manifest declares a visualization-only standalone plugin', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, 'plugin.json'), 'utf8'));
    assert.equal(manifest.id, 'multipad_highway_3d');
    assert.equal(manifest.type, 'visualization');
    assert.equal(manifest.bundled, false);
    assert.equal(manifest.script, 'screen.js');
    assert.equal(manifest.settings.html, 'settings.html');
    assert.equal(manifest.icon, 'assets/thumb.svg');
    assert.match(manifest.description, /^Multipad-focused/);
    assert.equal(manifest.description.includes('3x3'), false);
    assert.deepEqual(Object.keys(manifest.capabilities), ['visualization']);
    assert.equal(manifest.capabilities.visualization.roles.includes('provider'), true);
    assert.equal(manifest.capabilities['midi-input'], undefined);
    assert.equal(manifest.capabilities['note-detection'], undefined);
});

test('factory registers with a WebGL renderer and drum-chart auto-claim', () => {
    const factory = loadFactory();
    assert.equal(typeof factory, 'function');
    assert.equal(factory.contextType, 'webgl2');
    assert.equal(factory.matchesArrangement({ has_drum_tab: true, arrangement: 'Drums' }), true);
    assert.equal(factory.matchesArrangement({ has_drum_tab: true, arrangement: 'Percussion' }), true);
    assert.equal(factory.matchesArrangement({ has_drum_tab: false, arrangement: 'Drums' }), false);
    assert.equal(factory.matchesArrangement({ has_drum_tab: true, arrangement: 'Lead' }), false);
    assert.equal(factory.matchesArrangement({ has_drum_tab: true, arrangement: 'Bass' }), false);
    assert.equal(factory.__test.pluginId, 'multipad_highway_3d');
    assert.equal(factory.__test.contextType, 'webgl2');

    const guarded = loadFactoryHarness({ standardDrumHighway: true });
    assert.equal(guarded.matchesArrangement({ has_drum_tab: true, arrangement: 'Drums' }), true);
});

test('renderer lifecycle exposes WebGL state and tears down idempotently without a canvas', () => {
    const factory = loadFactory();
    const renderer = factory();
    assert.equal(renderer.contextType, 'webgl2');
    renderer.init(null, { currentTime: 0 });
    renderer.draw({ currentTime: 1 });
    renderer.resize(320, 180);
    assert.deepEqual(JSON.parse(JSON.stringify(renderer.__probe())), {
        pluginId: 'multipad_highway_3d',
        contextType: 'webgl2',
        initialized: false,
        ready: false,
        width: 320,
        height: 180,
        hasBundle: true,
        surfaces: 0,
        surfaceStyles: {},
        notes: [],
        tunnelLineVertices: null,
        labels: [],
        labelsVisible: false,
        drumTabPresent: false,
        drumTabHits: 0,
        projectionSource: '',
        projectedHits: 0,
        projectionStats: null,
        profileId: 'generic-3x3',
        padProfileId: 'generic-3x3',
        pedalProfileId: 'generic-pedals',
        triggerProfileId: 'generic-triggers',
        visibleNotes: 0,
        showLabels: true,
        cameraAngle: 0.35,
        sceneTheme: 'default',
        feedbackIntensity: 0.7,
        timingColors: true,
        hitSparks: true,
        cinematicLighting: true,
        backgroundStyle: 'particles',
        backgroundIntensity: 0.5,
    });
    renderer.destroy();
    renderer.destroy();
    assert.equal(factory.__test.liveInstanceCount(), 0);
});

test('renderer builds a real scene and draws a synthetic drum chart against a fake canvas without throwing', async () => {
    // Unlike the lifecycle test above (init(null, ...) - returns before
    // ever touching Three), this exercises the actual scene-build and
    // per-frame render path: initScene(), buildSurfaceGrid(), placeNote(),
    // placeLayoutPreview(), and settings-driven material disposal. This is
    // the path a bug like a ReferenceError inside placeNote (an undefined
    // constant it references) lives on - previously that class of bug was
    // only ever caught by noticing a blank/broken screenshot.
    const factory = loadFactory();
    const renderer = factory();
    renderer.init(fakeCanvas(), { currentTime: 0 });
    await flushAsync();

    const readyProbe = renderer.__probe();
    assert.equal(readyProbe.initialized, true);
    assert.equal(readyProbe.ready, true);
    assert.ok(readyProbe.surfaces > 0, 'surface grid should have built pad/pedal/trigger surfaces');

    const drumTab = {
        hits: [
            { t: 0, p: 'snare' },
            { t: 0.25, p: 'kick' },
            { t: 0.5, p: 'hh_closed' },
        ],
    };
    assert.doesNotThrow(() => {
        renderer.draw({ currentTime: 0.4, drumTab });
    });
    const drawnProbe = renderer.__probe();
    assert.equal(drawnProbe.drumTabPresent, true);
    assert.ok(drawnProbe.projectedHits > 0, 'drum hits should have projected onto pad/pedal surfaces');
    assert.ok(drawnProbe.visibleNotes > 0, 'at least one note should be visible this frame');

    // A settings change mid-session invalidates and disposes cached note
    // materials (see disposeNoteMaterials in 04-renderer.js) - exercise
    // that path too, not just the initial build.
    factory.__test.writeSetting('glowStrength', 0.9);
    assert.doesNotThrow(() => {
        renderer.draw({ currentTime: 0.45, drumTab });
    });

    assert.doesNotThrow(() => renderer.destroy());
    assert.equal(factory.__test.liveInstanceCount(), 0);
});

test('assigned pedal and trigger-outline surfaces get a colored outline, matching pad target styling', async () => {
    // Regression guard: pads already got a "colored outline, faint fill"
    // treatment when assigned (applyTargetZoneStyle, formerly pad-only
    // applyPadTargetStyle), but pedal-outline and trigger-outline surfaces
    // - which share the same rectangular addPlaneSurface geometry - fell
    // through to the generic neutral theme.pad fill / theme.edge outline
    // instead, so an assigned pedal never looked assigned.
    const { factory } = loadFactoryWithStorage();
    const t = factory.__test;
    const renderer = factory();

    // The default profile already maps hh_pedal -> outline-top and
    // kick -> outline-bottom (see DEFAULT_PEDAL_PROFILE) - exercise those
    // directly. Also route a piece onto the outline-left trigger-outline
    // surface, and leave outline-right unassigned, so both an assigned and
    // an unassigned trigger-outline surface are covered in the same pass.
    // The default pad profile already claims every non-pedal piece
    // (including 'snare'), and a piece may now only be assigned to one
    // target total, so swap in an empty pad profile to free 'snare' up for
    // the trigger below.
    const profile = t.readMultipadProfile();
    profile.padProfile = t.validatePadProfile({
        id: 'custom',
        name: 'Custom',
        rows: 1,
        cols: 1,
        pads: [{ id: '1', row: 0, col: 0, pieces: [] }],
    });
    profile.triggerProfile = t.validateTriggerProfile({
        triggers: [
            { id: 'ext-snare', surface: 'outline-left', pieces: ['snare'], color: '#123456' },
        ],
    });
    assert.equal(t.writeMultipadProfile(profile), true);

    renderer.init(fakeCanvas(), { currentTime: 0 });
    await flushAsync();
    const styles = renderer.__probe().surfaceStyles;

    const hhPedalColor = t.colorHexFromCss(t.DEFAULT_PEDAL_PROFILE.pedals.find(p => p.pieces.includes('hh_pedal')).color);
    const kickColor = t.colorHexFromCss(t.DEFAULT_PEDAL_PROFILE.pedals.find(p => p.pieces.includes('kick')).color);

    for (const [key, expectedColor] of [['outline-top', hhPedalColor], ['outline-bottom', kickColor]]) {
        const style = styles[key];
        assert.equal(style.kind, 'pedal-outline');
        assert.equal(style.active, true);
        assert.equal(style.fillColor, expectedColor, key + ' fill should match its routed piece color');
        assert.equal(style.edgeColor, expectedColor, key + ' edge should match its routed piece color');
        assert.equal(style.fillOpacity, t.TARGET_ZONE_FILL_OPACITY);
        assert.equal(style.edgeOpacity, t.TARGET_ZONE_EDGE_OPACITY);
    }

    const assignedTrigger = styles['outline-left'];
    assert.equal(assignedTrigger.kind, 'trigger-outline');
    assert.equal(assignedTrigger.active, true);
    assert.equal(assignedTrigger.fillColor, 0x123456);
    assert.equal(assignedTrigger.edgeColor, 0x123456);
    assert.equal(assignedTrigger.fillOpacity, t.TARGET_ZONE_FILL_OPACITY);
    assert.equal(assignedTrigger.edgeOpacity, t.TARGET_ZONE_EDGE_OPACITY);

    // Unassigned trigger-outline surface still grays out like any other
    // inactive target zone.
    const unassignedTrigger = styles['outline-right'];
    assert.equal(unassignedTrigger.kind, 'trigger-outline');
    assert.equal(unassignedTrigger.active, false);
    assert.equal(unassignedTrigger.fillColor, 0x2d3748);
    assert.equal(unassignedTrigger.edgeColor, 0x64748b);

    renderer.destroy();
});

test('target labels show full friendly piece names (one per line), not abbreviations, on pads and pedal/trigger surfaces', async () => {
    // Attach the DOM stub so createLabelSprite's `typeof document ===
    // 'undefined'` guard doesn't short-circuit it - every other test in
    // this file omits `document` on purpose (label sprites are irrelevant
    // to what they check), so this is the one place that needs it.
    const dom = createDomStub();
    const { factory } = loadFactoryWithStorage({}, { document: dom.document });
    const t = factory.__test;
    // Route a piece onto outline-left (trigger-outline) so a trigger
    // surface with a mapped piece is covered too; leave outline-right
    // unassigned so "no piece -> no label at all" is covered in the same
    // pass. The default pad profile already claims every non-pedal piece
    // (including 'tom_low', on pad 5 alongside 'tom_mid') and a piece may
    // only live on one target - free 'tom_low' up for the trigger instead
    // of swapping out the whole pad profile, so pad:1/pad:8 below still
    // exercise the real default pad layout.
    const profile = t.readMultipadProfile();
    const padProfileRaw = JSON.parse(JSON.stringify(profile.padProfile));
    padProfileRaw.pads.find(p => p.id === '5').pieces = ['tom_mid'];
    profile.padProfile = t.validatePadProfile(padProfileRaw);
    profile.triggerProfile = t.validateTriggerProfile({
        triggers: [{ id: 'ext-tomhi', surface: 'outline-left', pieces: ['tom_low'], color: '#123456' }],
    });
    assert.equal(t.writeMultipadProfile(profile), true);

    const renderer = factory();
    renderer.init(fakeCanvas(), { currentTime: 0 });
    await flushAsync();

    const labels = renderer.__probe().labels;
    const byKey = new Map(labels.map(l => [l.surfaceKey, l.lines]));

    // Pad '1' in the default 3x3 layout holds 4 pieces (crash_l, splash,
    // china, stack) - one full-name line per piece, not the short
    // PIECE_LABELS abbreviation ("CRl") the pad used to show as its single label.
    assert.deepEqual(byKey.get('pad:1'), ['Crash (left)', 'Splash', 'China', 'Stack']);
    // Single-piece pad: one line, full name.
    assert.deepEqual(byKey.get('pad:8'), ['Snare']);
    // Unassigned pad still gets an em-dash placeholder (existing convention).
    // generic-3x3 has no unassigned pads by default, so this just documents
    // pad:1..9 are all present; the placeholder case is covered by the pad
    // profile test's inactive-pad path elsewhere.

    // Pedal-outline surfaces (default profile: hh_pedal -> top, kick -> bottom).
    assert.deepEqual(byKey.get('outline-top'), ['Hi-hat (pedal)']);
    assert.deepEqual(byKey.get('outline-bottom'), ['Kick']);

    // Trigger-outline: assigned surface gets a label, unassigned gets none
    // at all (not an empty/placeholder entry).
    assert.deepEqual(byKey.get('outline-left'), ['Tom - low']);
    assert.equal(byKey.has('outline-right'), false);

    // showLabels off: sprites built while it was on are left in place (no
    // profile change happened, so buildSurfaceGrid's cache guard skips a
    // rebuild) - only the group's visibility flips off.
    t.writeSetting('showLabels', false);
    renderer.draw({ currentTime: 0 });
    assert.equal(renderer.__probe().labelsVisible, false);
    assert.ok(renderer.__probe().labels.length > 0, 'already-built label sprites should remain (just hidden)');

    renderer.destroy();
});

test('toggling showLabels off then on actually (re)builds label sprites, not just visibility', async () => {
    // Regression guard: label sprites are only built while showLabels is
    // on (skipped entirely otherwise, for efficiency - see buildSurfaceGrid),
    // so flipping the setting off -> on has to force a real surface-grid
    // rebuild or labelGroup stays empty forever (updateSettingsFromStorage's
    // labelsJustEnabled check nulls activeSurfaceLayoutKey to force this).
    const dom = createDomStub();
    const { factory } = loadFactoryWithStorage({}, { document: dom.document });
    const t = factory.__test;
    t.writeSetting('showLabels', false);

    const renderer = factory();
    renderer.init(fakeCanvas(), { currentTime: 0 });
    await flushAsync();

    // Nothing was ever built while off.
    assert.equal(renderer.__probe().labels.length, 0);

    // buildSurfaceGrid is only reached again via projectionForBundle's
    // drumTab-cache-miss path (settingsVersion changed, so this misses) -
    // a bundle with no drumTab at all never revisits it, regardless of
    // showLabels.
    t.writeSetting('showLabels', true);
    renderer.draw({ currentTime: 0, drumTab: { hits: [] } });
    assert.equal(renderer.__probe().labelsVisible, true);
    assert.ok(renderer.__probe().labels.length > 0, 'label sprites should now be built and visible');

    renderer.destroy();
});

test('createLabelSprite shrinks font below the old fixed 16px floor for pads with many pieces', async () => {
    // Regression guard: font size used to be pinned at Math.max(16, ...)
    // regardless of line count, so a pad with many pieces stacked in the
    // fixed-height canvas got overlapping/illegible text instead of
    // continuing to shrink. Nothing caps pieces-per-pad, so this is reachable.
    const dom = createDomStub();
    const { factory } = loadFactoryWithStorage({}, { document: dom.document });
    const t = factory.__test;

    const manyPieces = t.ALL_PIECES.slice(0, 10);
    const profile = t.readMultipadProfile();
    profile.padProfile = t.validatePadProfile({
        id: 'custom', name: 'Custom', rows: 1, cols: 1,
        pads: [{ id: '1', row: 0, col: 0, pieces: manyPieces }],
    });
    profile.pedalProfile = t.validatePedalProfile({ pedals: [] });
    profile.triggerProfile = t.validateTriggerProfile({ triggers: [] });
    assert.equal(t.writeMultipadProfile(profile), true);

    const renderer = factory();
    renderer.init(fakeCanvas(), { currentTime: 0 });
    await flushAsync();

    const label = renderer.__probe().labels.find(l => l.surfaceKey === 'pad:1');
    assert.ok(label, 'expected the many-piece pad to have a label');
    assert.equal(label.lines.length, manyPieces.length);
    for (const size of label.fontSizes) {
        assert.ok(size < 16, `expected font size < 16px for ${manyPieces.length} stacked lines, got ${size}`);
    }

    renderer.destroy();
});

test('player-controls label toggle button mounts into v2 #player-controls, is idempotent, and toggles showLabels', () => {
    const dom = createDomStub();
    const playerControls = dom.document.createElement('div');
    playerControls.id = 'player-controls';
    dom.registerElement(playerControls);

    const { factory } = loadFactoryWithStorage({}, { document: dom.document });
    const t = factory.__test;

    t.injectLabelsToggleButton();
    const btn = dom.document.getElementById(t.LABELS_BTN_ID);
    assert.ok(btn, 'button should be injected into #player-controls');
    assert.ok(playerControls.contains(btn));

    // Idempotent: re-entering the player screen must not add a second button.
    t.injectLabelsToggleButton();
    assert.equal(playerControls.children.filter(c => c.id === t.LABELS_BTN_ID).length, 1);

    // showLabels defaults to true - button starts in the "on" visual state.
    assert.equal(btn.getAttribute('aria-pressed'), 'true');
    assert.ok(btn.className.includes('text-accent'));

    // Clicking toggles the shared setting and updates the button's own
    // visual state - this is the one control for every target label (pad,
    // pedal, and trigger surfaces all read the same showLabels setting).
    btn.onclick();
    assert.equal(t.readSettings().showLabels, false);
    assert.equal(btn.getAttribute('aria-pressed'), 'false');
    assert.ok(btn.className.includes('text-gray-400'));

    btn.onclick();
    assert.equal(t.readSettings().showLabels, true);
    assert.equal(btn.getAttribute('aria-pressed'), 'true');
});

test('player-controls label toggle button mounts into the v3 plugin-control slot instead of #player-controls', () => {
    const dom = createDomStub();
    const v3Slot = dom.document.createElement('div');
    v3Slot.id = 'v3-rail-pop-plugins';
    dom.registerElement(v3Slot);

    const { factory } = loadFactoryWithStorage({}, {
        document: dom.document,
        feedBack: { uiVersion: 'v3', ui: { playerControlSlot: () => v3Slot } },
    });
    const t = factory.__test;
    t.injectLabelsToggleButton();
    const btn = dom.document.getElementById(t.LABELS_BTN_ID);
    assert.ok(btn, 'button should be injected into the v3 slot');
    assert.ok(v3Slot.contains(btn));
});

test('player-controls label toggle button falls back to v2 #player-controls when the v3 host API throws', () => {
    // Regression guard: playerSlot() used to call
    // window.feedBack.ui.playerControlSlot() with no try/catch, unlike the
    // in-repo tuner plugin's copy of this exact pattern - a host API
    // failure would propagate out of injectLabelsToggleButton() instead of
    // degrading to the v2 fallback.
    const dom = createDomStub();
    const playerControls = dom.document.createElement('div');
    playerControls.id = 'player-controls';
    dom.registerElement(playerControls);

    const { factory } = loadFactoryWithStorage({}, {
        document: dom.document,
        feedBack: {
            uiVersion: 'v3',
            ui: { playerControlSlot: () => { throw new Error('host slot API failure'); } },
        },
    });
    const t = factory.__test;
    assert.doesNotThrow(() => t.injectLabelsToggleButton());
    const btn = dom.document.getElementById(t.LABELS_BTN_ID);
    assert.ok(btn, 'button should still be injected via the v2 fallback');
    assert.ok(playerControls.contains(btn));
});

test('entering the player screen (screen:changed) injects the label toggle button', () => {
    const dom = createDomStub();
    const playerControls = dom.document.createElement('div');
    playerControls.id = 'player-controls';
    dom.registerElement(playerControls);

    let screenChangedHandler = null;
    const feedBack = {
        uiVersion: 'v2',
        on(event, cb) { if (event === 'screen:changed') screenChangedHandler = cb; },
    };
    const { factory } = loadFactoryWithStorage({}, { document: dom.document, feedBack });
    const t = factory.__test;
    assert.equal(typeof screenChangedHandler, 'function', 'screen:changed handler should be registered on load');
    assert.equal(dom.document.getElementById(t.LABELS_BTN_ID), null, 'no button before any screen change');

    screenChangedHandler({ detail: { id: 'library' } });
    assert.equal(dom.document.getElementById(t.LABELS_BTN_ID), null, 'non-player screens must not inject the button');

    screenChangedHandler({ detail: { id: 'player' } });
    assert.ok(dom.document.getElementById(t.LABELS_BTN_ID), 'entering the player screen should inject the button');
});

test('past-threshold note gems always start their fade at the repeat-gem opacity, even non-repeat gems', async () => {
    // The previous behavior started a fresh (non-repeat) gem's past-threshold
    // fade from its own brighter NOTE_BODY_OPACITY/NOTE_FACE_OPACITY, which
    // read as too bright right after crossing compared to a repeat gem
    // (which already started dimmer). Both should now start identically.
    const factory = loadFactory();
    const t = factory.__test;
    const renderer = factory();
    renderer.init(fakeCanvas(), { currentTime: 0 });
    await flushAsync();

    const drumTab = {
        hits: [
            // Earlier, separate hit group (well outside the default 8ms hit
            // group window) establishes 'snare' as already-hit, so the t=0
            // snare hit below is a repeat of the SAME pad surface.
            { t: -0.2, p: 'snare' },
            // t=0 group: snare repeats its own pad surface (isRepeat=true);
            // tom_hi hits a pad surface for the first time (isRepeat=false).
            // Both cross the threshold at the exact same instant.
            { t: 0, p: 'snare' },
            { t: 0, p: 'tom_hi' },
        ],
    };
    renderer.draw({ currentTime: 0, drumTab });

    const notes = renderer.__probe().notes;
    const repeatNote = notes.find(n => n.surfaceId === 'pad:8' && n.isRepeat);
    const freshNote = notes.find(n => n.surfaceId === 'pad:4' && !n.isRepeat);
    assert.ok(repeatNote, 'expected the repeated snare gem to be visible this frame');
    assert.ok(freshNote, 'expected the fresh tom_hi gem to be visible this frame');
    assert.equal(repeatNote.isPastThreshold, true);
    assert.equal(freshNote.isPastThreshold, true);

    // Right at the crossing instant (secSinceCrossing=0), both should read
    // at exactly the repeat-gem opacity level - not the fresh gem's own
    // brighter pre-crossing level.
    assert.equal(freshNote.bodyOpacity, t.NOTE_REPEAT_BODY_OPACITY);
    assert.equal(freshNote.faceOpacity, t.NOTE_REPEAT_FACE_OPACITY);
    assert.equal(repeatNote.bodyOpacity, freshNote.bodyOpacity);
    assert.equal(repeatNote.faceOpacity, freshNote.faceOpacity);

    // Sanity check the constants actually differ, so the equality assertions
    // above are a real regression guard and not vacuously true.
    assert.ok(t.NOTE_REPEAT_BODY_OPACITY < t.NOTE_BODY_OPACITY);
    assert.ok(t.NOTE_REPEAT_FACE_OPACITY < t.NOTE_FACE_OPACITY);

    renderer.destroy();
});

test('projectRectCorners derives its corners from projectGridPoint, unscaled', () => {
    const t = loadFactory().__test;

    // progress=1: corners are exactly the rect's real (x +/- w/2, y +/- h/2)
    // position - the same "arrived" invariant projectGridPoint itself
    // guarantees for a single point.
    assert.deepEqual(plain(t.projectRectCorners(0, t.GRID_CENTER_Y, 2, 4, 1, 0.5)), [
        [-1, t.GRID_CENTER_Y - 2, 0.5],
        [1, t.GRID_CENTER_Y - 2, 0.5],
        [1, t.GRID_CENTER_Y + 2, 0.5],
        [-1, t.GRID_CENTER_Y + 2, 0.5],
    ]);

    // progress=0: every corner is projectGridPoint(x+dx, y-GRID_CENTER_Y+dy, 0)
    // - i.e. derived from the exact same function a single projected point
    // (a note gem, the layout-preview outline's center) uses, not a
    // separately scaled formula.
    const corners = t.projectRectCorners(0, t.GRID_CENTER_Y, 2, 4, 0, -10);
    const expected = [[-1, -2], [1, -2], [1, 2], [-1, 2]].map(([dx, dy]) => {
        const p = t.projectGridPoint(dx, dy, 0);
        return [p.x, p.y, -10];
    });
    assert.deepEqual(plain(corners), expected);
});

test('tunnel guide lines converge using projectRectCorners, matching note gem placement', async () => {
    // Regression guard: addTunnelLines used to hand-roll its own back-corner
    // formula that scaled each corner's offset from the grid center by a
    // fixed TUNNEL_BACK_SCALE, instead of leaving the offset unscaled like
    // projectGridPoint (the single source of truth placeNote and
    // placeLayoutPreview already share) - so the lines converged along a
    // different curve than the note gems traveling through them and didn't
    // line up. Verify the actual rendered guide-line geometry's corners
    // match projectRectCorners exactly - the same helper, not a re-derived
    // copy of its math.
    const factory = loadFactory();
    const t = factory.__test;
    const renderer = factory();
    renderer.init(fakeCanvas(), { currentTime: 0 });
    await flushAsync();

    const vertices = renderer.__probe().tunnelLineVertices;
    assert.ok(Array.isArray(vertices) && vertices.length > 0, 'expected tunnel line geometry to have been built');

    const points = [];
    for (let i = 0; i < vertices.length; i += 3) {
        points.push([vertices[i], vertices[i + 1], vertices[i + 2]]);
    }

    const layout = t.buildSurfaceLayout(t.DEFAULT_PAD_PROFILE);

    function pointKey([x, y, z]) {
        return [x, y, z].map(n => Math.round(n * 1000) / 1000).join(',');
    }

    const expectedFront = new Set(t.projectRectCorners(0, t.GRID_CENTER_Y, layout.gridW, layout.gridH, 1, 0.015).map(pointKey));
    const expectedBack = new Set(t.projectRectCorners(0, t.GRID_CENTER_Y, layout.gridW, layout.gridH, 0, -t.TUNNEL_DEPTH).map(pointKey));

    const actualFront = new Set(points.filter(p => Math.abs(p[2] - 0.015) < 1e-6).map(pointKey));
    const actualBack = new Set(points.filter(p => Math.abs(p[2] - (-t.TUNNEL_DEPTH)) < 1e-6).map(pointKey));

    assert.deepEqual(actualFront, expectedFront, 'front corners should match projectRectCorners at progress=1');
    assert.deepEqual(actualBack, expectedBack, 'back corners should match projectRectCorners at progress=0');

    renderer.destroy();
});

test('renderer survives a destroy/re-init cycle on the same instance (song-switch lifecycle)', async () => {
    // playSong() does stop() -> init() on the SAME renderer instance to
    // reuse the canvas for the next song (see the setRenderer contract in
    // CLAUDE.md) - so init() must tolerate running again after destroy(),
    // including rebuilding anything teardown() disposed (note materials,
    // the layout-preview outline material, pooled meshes).
    const factory = loadFactory();
    const renderer = factory();

    renderer.init(fakeCanvas(), { currentTime: 0 });
    await flushAsync();
    assert.equal(renderer.__probe().ready, true);
    renderer.draw({ currentTime: 0, drumTab: { hits: [{ t: 0, p: 'snare' }] } });

    renderer.destroy();
    assert.equal(renderer.__probe().ready, false);

    assert.doesNotThrow(() => renderer.init(fakeCanvas(), { currentTime: 0 }));
    await flushAsync();
    const probe = renderer.__probe();
    assert.equal(probe.ready, true);
    assert.ok(probe.surfaces > 0);
    assert.doesNotThrow(() => {
        renderer.draw({ currentTime: 0.1, drumTab: { hits: [{ t: 0, p: 'kick' }] } });
    });

    renderer.destroy();
    assert.equal(factory.__test.liveInstanceCount(), 0);
});

test('pad profile validation accepts m x n layouts and strips invalid entries', () => {
    const t = loadFactory().__test;
    const profile = t.validatePadProfile({
        id: 'yamaha-4x3',
        name: '  Yamaha style  ',
        rows: 4,
        cols: 3,
        pads: [
            // 'kick' is now a normal assignable piece (any piece can go on
            // a pad, pedal, or trigger) - only 'bogus' should be stripped.
            { row: 0, col: 0, label: 'A', pieces: ['kick', 'snare', 'bogus'] },
            { row: 0, col: 0, label: 'dup coordinate', pieces: ['tom_hi'] },
            { id: 'dup-pad', row: 0, col: 1, label: 'dup id first', pieces: ['tom_hi'] },
            { id: 'dup-pad', row: 0, col: 2, label: 'dup id second', pieces: ['tom_mid'] },
            { row: 0, col: 1, label: 'B', pieces: ['tom_hi', 'snare'] },
            { row: 9, col: 9, pieces: ['ride'] },
        ],
        fallbacks: JSON.parse('{"tom_low":"tom_hi","__proto__":"snare"}'),
    });

    assert.equal(profile.id, 'yamaha-4x3');
    assert.equal(profile.name, 'Yamaha style');
    assert.equal(profile.rows, 4);
    assert.equal(profile.cols, 3);
    assert.equal(profile.pads.length, 2);
    assert.deepEqual(plain(profile.pads[0].pieces), ['kick', 'snare']);
    assert.deepEqual(plain(profile.pads[1].pieces), ['tom_hi']);
    assert.deepEqual(plain(profile.pads.map(p => p.id)), ['1', 'dup-pad']);
    assert.equal(profile.fallbacks.tom_low, 'tom_hi');
    // fallbacks injects "__proto__":"snare" via JSON.parse - JSON.parse
    // assigns __proto__ as a plain own key (it never triggers the
    // Object.prototype.__proto__ setter), and the piece-set filter would
    // reject it as an unknown piece regardless, so this can't actually
    // pollute anything either way. Assert the two real defenses directly
    // instead: the returned fallbacks map is genuinely null-prototype
    // (matches validatePadProfile's `Object.create(null)`), and
    // "__proto__" never became a real member of it.
    assert.equal(Object.getPrototypeOf(profile.fallbacks), null);
    assert.equal(Object.prototype.hasOwnProperty.call(profile.fallbacks, '__proto__'), false);
});

test('padProfileLayoutKey changes when a pad gains or loses a non-first piece', () => {
    // Regression guard: the key used to hash only [id, row, col, label] -
    // label is derived from pieces[0] only, so adding/removing a 2nd/3rd
    // piece left the key (and therefore the cached surface-grid rebuild
    // gate in buildSurfaceGrid) unchanged, and the new multi-line label
    // (one line per piece) silently went stale.
    const t = loadFactory().__test;
    const base = t.validatePadProfile({
        id: 'p', name: 'p', rows: 1, cols: 1,
        pads: [{ id: '1', row: 0, col: 0, pieces: ['crash_l'] }],
    });
    const withSecondPiece = t.validatePadProfile({
        id: 'p', name: 'p', rows: 1, cols: 1,
        pads: [{ id: '1', row: 0, col: 0, pieces: ['crash_l', 'splash'] }],
    });
    // Same label either way (derived from pieces[0] only) - the bug was
    // relying on label alone to detect a change.
    assert.equal(base.pads[0].label, withSecondPiece.pads[0].label);
    assert.notEqual(t.padProfileLayoutKey(base), t.padProfileLayoutKey(withSecondPiece));
});

test('default pad profile routes every known pad piece somewhere', () => {
    const t = loadFactory().__test;
    const routeMap = t.buildPieceToPadMap(t.DEFAULT_PAD_PROFILE);
    const expectedSurfaces = {
        snare: 'pad:8',
        snare_xstick: 'pad:7',
        hh_closed: 'pad:2',
        hh_open: 'pad:2',
        tom_hi: 'pad:4',
        tom_mid: 'pad:5',
        tom_low: 'pad:5',
        tom_floor: 'pad:9',
        stack: 'pad:1',
        crash_l: 'pad:1',
        crash_r: 'pad:3',
        splash: 'pad:1',
        china: 'pad:1',
        ride: 'pad:6',
        ride_bell: 'pad:6',
        bell: 'pad:6',
    };
    for (const piece of t.PAD_PIECES) {
        assert.ok(routeMap[piece], piece);
        assert.equal(routeMap[piece].routeType, 'pad');
        assert.match(routeMap[piece].pad.id, /^\d+$/);
        assert.equal('pad:' + routeMap[piece].pad.id, expectedSurfaces[piece], piece);
    }
    assert.equal(routeMap.kick, undefined);
    assert.equal(routeMap.hh_pedal, undefined);
});

test('PIECE_FRIENDLY_LABELS covers every known piece with a non-abbreviated name', () => {
    // Guards against the class of drift this feature was built to avoid:
    // adding a new piece to ALL_PIECES without a matching full display
    // name would silently fall back to the raw id in both the 3D highway
    // labels and the settings panel (they share this one dict).
    const t = loadFactory().__test;
    for (const piece of t.ALL_PIECES) {
        assert.ok(
            Object.prototype.hasOwnProperty.call(t.PIECE_FRIENDLY_LABELS, piece),
            `PIECE_FRIENDLY_LABELS is missing an entry for ${piece}`
        );
        assert.equal(t.friendlyPieceLabel(piece), t.PIECE_FRIENDLY_LABELS[piece]);
    }
    assert.equal(Object.keys(t.PIECE_FRIENDLY_LABELS).length, t.ALL_PIECES.length);
    // Unknown/future piece ids fall back to the raw id rather than throwing
    // or rendering "undefined".
    assert.equal(t.friendlyPieceLabel('future_piece'), 'future_piece');
});

test('empty drum-tab hit streams are treated as real charts, not demo fallback', () => {
    const t = loadFactory().__test;
    assert.equal(t.hasDrumTabHitStream({ hits: [] }), true);
    assert.equal(t.hasDrumTabHitStream({ hits: [{ t: 0, p: 'kick' }] }), true);
    assert.equal(t.hasDrumTabHitStream(null), false);
    assert.equal(t.hasDrumTabHitStream({}), false);
});

test('chart source selection only accepts bundle drum tabs', () => {
    const t = loadFactory().__test;
    const drumTab = { hits: [{ t: 0, p: 'kick' }] };
    assert.deepEqual(plain(t.chartSourceFromBundle({ drumTab })), {
        type: 'drumTab',
        drumTab: { hits: [{ t: 0, p: 'kick' }] },
        hitCount: 1,
    });
    assert.deepEqual(plain(t.chartSourceFromBundle({ drumTab: { hits: [] }, notes: [{ t: 0, s: 1, f: 12 }] })), {
        type: 'drumTab',
        drumTab: { hits: [] },
        hitCount: 0,
    });
    assert.deepEqual(plain(t.chartSourceFromBundle({ notes: [{ t: 0, s: 1, f: 12 }] })), {
        type: 'none',
        drumTab: null,
        hitCount: -1,
    });
    assert.equal(t.projectionCacheMatchesSource(
        { type: 'drumTab', drumTab, hitCount: 1 },
        { sourceType: 'drumTab', drumTab, hitCount: 1, settingsVersion: 0 }
    ), true);
});

test('external trigger profile routes off-grid pad inputs by surface', () => {
    const t = loadFactory().__test;
    const profile = t.validateTriggerProfile({
        id: 'external-triggers',
        name: 'External snare',
        // 'kick' is now a normal assignable piece, same as any other - a
        // trigger can hold it alongside 'snare' (both survive; only 'bogus'
        // and the duplicate-surface entry are dropped).
        triggers: [
            { id: 'snare-in', surface: 'outline-left', label: 'Ext Snare', pieces: ['snare', 'kick'], color: '#A78BFA' },
            { id: 'bad', surface: 'outline-right', label: 'Bad', pieces: ['bogus'] },
            { id: 'dup-surface', surface: 'outline-left', label: 'Dup', pieces: ['tom_hi'] },
        ],
    });

    assert.equal(profile.id, 'external-triggers');
    assert.equal(profile.name, 'External snare');
    assert.deepEqual(plain(profile.triggers.map(t => t.id)), ['snare-in', 'bad']);
    assert.deepEqual(plain(profile.triggers[0].pieces), ['snare', 'kick']);
    assert.deepEqual(plain(profile.triggers[1].pieces), []);
    assert.equal(profile.triggers[0].surface, 'outline-left');
    assert.equal(profile.triggers[0].color, '#a78bfa');
    assert.equal(t.colorHexFromCss(profile.triggers[0].color), 0xa78bfa);
    assert.equal(t.colorHexFromCss('not-a-color'), null);
    assert.deepEqual(plain(t.DEFAULT_TRIGGER_PROFILE.triggers), []);

    const triggerMap = t.buildPieceToTriggerMap(profile);
    assert.equal(triggerMap.snare.id, 'snare-in');
    assert.equal(triggerMap.kick.id, 'snare-in');

    const projected = t.projectDrumTab({
        hits: [
            { t: 0, p: 'snare' },
            { t: 0.004, p: 'hh_closed' },
        ],
    }, { triggerProfile: profile, hitGroupWindowSec: 0.008 });

    assert.deepEqual(plain(projected.hitEvents.map(e => e.type)), ['trigger', 'pad']);
    assert.equal(projected.hitEvents[0].triggerId, 'snare-in');
    assert.equal(projected.hitEvents[0].surfaceId, 'outline-left');
    assert.equal(projected.hitEvents[1].surfaceId, 'pad:2');
    assert.deepEqual(plain(projected.hitGroups[0].triggerIds), ['snare-in']);
    assert.deepEqual(plain(projected.hitGroups[0].triggerSurfaces), ['outline-left']);
    assert.deepEqual(plain(projected.hitGroups[0].padIds), ['2']);
});

test('external trigger profile supports external pad center and edge surfaces', () => {
    const t = loadFactory().__test;
    const profile = t.validateTriggerProfile({
        id: 'external-pad-zones',
        name: 'External pad zones',
        triggers: [
            { id: 'left-center', surface: 'external-left-center', label: 'Left', pieces: ['snare'], color: '#FDE68A' },
            { id: 'left-edge', surface: 'external-left-edge', label: 'Left Edge', pieces: ['snare_xstick'], color: '#FACC15' },
            { id: 'right-center', surface: 'external-right-center', label: 'Right', pieces: ['ride'], color: '#FDBA74' },
            { id: 'right-edge', surface: 'external-right-edge', label: 'Right Edge', pieces: ['ride_bell'], color: '#F97316' },
        ],
    });

    assert.deepEqual(plain(profile.triggers.map(trigger => trigger.surface)), [
        'external-left-center',
        'external-left-edge',
        'external-right-center',
        'external-right-edge',
    ]);
    const projected = t.projectDrumTab({
        hits: [
            { t: 0, p: 'snare' },
            { t: 0.25, p: 'snare_xstick' },
            { t: 0.50, p: 'ride' },
            { t: 0.75, p: 'ride_bell' },
        ],
    }, { triggerProfile: profile });

    assert.deepEqual(plain(projected.hitEvents.map(event => event.type)), ['trigger', 'trigger', 'trigger', 'trigger']);
    assert.deepEqual(plain(projected.hitEvents.map(event => event.surfaceId)), [
        'external-left-center',
        'external-left-edge',
        'external-right-center',
        'external-right-edge',
    ]);
});

test('external trigger profile supports a third (rim) zone per side', () => {
    const t = loadFactory().__test;
    const profile = t.validateTriggerProfile({
        id: 'external-pad-zones-3',
        name: 'External pad zones 3',
        triggerSlots: [
            { id: 'trigger-1', zones: 3 },
            { id: 'trigger-2', zones: 3 },
        ],
        triggers: [
            { id: 'left-center', surface: 'external-left-center', label: 'Left', pieces: ['snare'], color: '#FDE68A' },
            { id: 'left-edge', surface: 'external-left-edge', label: 'Left Edge', pieces: ['snare_xstick'], color: '#FACC15' },
            { id: 'left-rim', surface: 'external-left-rim', label: 'Left Rim', pieces: ['tom_hi'], color: '#F87171' },
            { id: 'right-center', surface: 'external-right-center', label: 'Right', pieces: ['ride'], color: '#FDBA74' },
            { id: 'right-edge', surface: 'external-right-edge', label: 'Right Edge', pieces: ['ride_bell'], color: '#F97316' },
            { id: 'right-rim', surface: 'external-right-rim', label: 'Right Rim', pieces: ['tom_mid'], color: '#FB923C' },
        ],
    });

    assert.deepEqual(plain(profile.triggers.map(trigger => trigger.surface)), [
        'external-left-center',
        'external-left-edge',
        'external-left-rim',
        'external-right-center',
        'external-right-edge',
        'external-right-rim',
    ]);
    assert.deepEqual(plain(profile.triggerSlots), [
        { id: 'trigger-1', zones: 3 },
        { id: 'trigger-2', zones: 3 },
    ]);

    const projected = t.projectDrumTab({
        hits: [
            { t: 0, p: 'snare' },
            { t: 0.25, p: 'snare_xstick' },
            { t: 0.5, p: 'tom_hi' },
            { t: 0.75, p: 'ride' },
            { t: 1.0, p: 'ride_bell' },
            { t: 1.25, p: 'tom_mid' },
        ],
    }, { triggerProfile: profile });

    assert.deepEqual(plain(projected.hitEvents.map(event => event.surfaceId)), [
        'external-left-center',
        'external-left-edge',
        'external-left-rim',
        'external-right-center',
        'external-right-edge',
        'external-right-rim',
    ]);
});

test('inferTriggerSlots reports 3 zones when only a rim surface is assigned', () => {
    const t = loadFactory().__test;
    const profile = t.validateTriggerProfile({
        triggers: [
            { id: 'left-rim', surface: 'external-left-rim', pieces: ['tom_hi'] },
        ],
    });
    assert.deepEqual(plain(profile.triggerSlots), [{ id: 'trigger-1', zones: 3 }]);
});

test('trigger zones clamp to the 1-3 range', () => {
    const t = loadFactory().__test;
    const tooMany = t.validateTriggerProfile({
        triggerSlots: [{ id: 'trigger-1', zones: 9 }],
        triggers: [],
    });
    assert.equal(tooMany.triggerSlots[0].zones, 3);
    const tooFew = t.validateTriggerProfile({
        triggerSlots: [{ id: 'trigger-1', zones: 0 }],
        triggers: [],
    });
    assert.equal(tooFew.triggerSlots[0].zones, 1);
});

test('surface layout renders every accepted pedal and trigger surface', () => {
    const t = loadFactory().__test;
    const layout = t.buildSurfaceLayout(t.DEFAULT_PAD_PROFILE);
    const byKey = new Map(layout.surfaces.map(surface => [surface.key, surface]));

    for (const surface of t.PEDAL_SURFACES.concat(t.TRIGGER_SURFACES)) {
        assert.ok(byKey.has(surface), surface);
    }

    const leftCenter = byKey.get('external-left-center');
    const leftEdge = byKey.get('external-left-edge');
    const rightCenter = byKey.get('external-right-center');
    const rightEdge = byKey.get('external-right-edge');
    const leftOutline = byKey.get('outline-left');
    const rightOutline = byKey.get('outline-right');
    const topOutline = byKey.get('outline-top');
    const bottomOutline = byKey.get('outline-bottom');
    assert.equal(topOutline.x, bottomOutline.x);
    assert.equal(topOutline.w, bottomOutline.w);
    assert.equal(topOutline.h, bottomOutline.h);
    assert.equal(leftCenter.shape, 'circle');
    assert.equal(leftEdge.shape, 'ring');
    assert.equal(rightCenter.shape, 'circle');
    assert.equal(rightEdge.shape, 'ring');
    assert.equal(leftCenter.active, false);
    assert.equal(leftEdge.active, false);
    assert.equal(rightCenter.active, false);
    assert.equal(rightEdge.active, false);
    assert.equal(leftCenter.color, 0x2d3748);
    assert.equal(leftEdge.color, 0x2d3748);
    assert.equal(rightCenter.color, 0x2d3748);
    assert.equal(rightEdge.color, 0x2d3748);
    assert.equal(leftCenter.x, leftEdge.x);
    assert.equal(rightCenter.x, rightEdge.x);
    assert.equal(leftCenter.x, -rightCenter.x);
    assert.equal(leftCenter.y, rightCenter.y);
    assert.equal(leftEdge.outerRadius - leftEdge.innerRadius >= 0.12, true);
    assert.equal(rightEdge.outerRadius - rightEdge.innerRadius >= 0.12, true);
    assert.equal(leftEdge.x < leftOutline.x, true);
    assert.equal(rightEdge.x > rightOutline.x, true);

    const leftRim = byKey.get('external-left-rim');
    const rightRim = byKey.get('external-right-rim');
    assert.equal(leftRim.shape, 'ring');
    assert.equal(rightRim.shape, 'ring');
    assert.equal(leftRim.active, false);
    assert.equal(rightRim.active, false);
    assert.equal(leftRim.color, 0x2d3748);
    assert.equal(rightRim.color, 0x2d3748);
    // Rim is concentric with center/edge and sits strictly outside the edge ring.
    assert.equal(leftRim.x, leftEdge.x);
    assert.equal(rightRim.x, rightEdge.x);
    assert.equal(leftRim.innerRadius, leftEdge.outerRadius);
    assert.equal(rightRim.innerRadius, rightEdge.outerRadius);
    assert.equal(leftRim.outerRadius > leftEdge.outerRadius, true);
    assert.equal(rightRim.outerRadius > rightEdge.outerRadius, true);
    assert.equal(leftRim.x < leftOutline.x, true);
    assert.equal(rightRim.x > rightOutline.x, true);
});

test('surface layout preserves black profile colors', () => {
    const t = loadFactory().__test;
    const padProfile = t.validatePadProfile({
        id: 'black-pad',
        name: 'Black pad',
        rows: 1,
        cols: 1,
        pads: [
            { id: 'pad-1', row: 0, col: 0, pieces: ['snare'], color: '#000000' },
        ],
    });
    const pedalProfile = t.validatePedalProfile({
        pedals: [
            { id: 'black-kick', surface: 'outline-bottom', pieces: ['kick'], color: '#000000' },
        ],
    });
    const triggerProfile = t.validateTriggerProfile({
        triggers: [
            { id: 'black-trigger', surface: 'external-left-center', pieces: ['tom_hi'], color: '#000000' },
        ],
    });
    const layout = t.buildSurfaceLayout(padProfile, pedalProfile, triggerProfile);
    const byKey = new Map(layout.surfaces.map(surface => [surface.key, surface]));

    assert.equal(byKey.get('pad:pad-1').color, 0x000000);
    assert.equal(byKey.get('outline-bottom').color, 0x000000);
    assert.equal(byKey.get('external-left-center').color, 0x000000);
});

test('hit event lower bound starts real-chart scans near the visible window', () => {
    const t = loadFactory().__test;
    const events = [
        { t: 0.00 },
        { t: 0.25 },
        { t: 0.50 },
        { t: 1.00 },
        { t: 2.00 },
    ];

    assert.equal(t.lowerBoundHitEvents(events, -1), 0);
    assert.equal(t.lowerBoundHitEvents(events, 0.25), 1);
    assert.equal(t.lowerBoundHitEvents(events, 0.26), 2);
    assert.equal(t.lowerBoundHitEvents(events, 3), events.length);
    assert.equal(t.lowerBoundHitEvents(null, 0), 0);
});

test('invalid pad profile dimensions reject the profile and project with the default', () => {
    const t = loadFactory().__test;
    const badProfile = {
        id: 'bad',
        name: 'Bad',
        rows: 999,
        cols: 3,
        pads: [{ row: 0, col: 0, pieces: ['snare'] }],
    };
    assert.equal(t.validatePadProfile(badProfile), null);

    const projected = t.projectDrumTab({
        hits: [{ t: 0, p: 'snare' }],
    }, { padProfile: badProfile });

    assert.equal(projected.padProfile.id, 'generic-3x3');
    assert.equal(projected.padProfile.rows, 3);
    assert.equal(projected.padProfile.cols, 3);
    assert.equal(projected.hitEvents[0].piece, 'snare');
});

test('pedal profile validation supports kick and hi-hat pedal surfaces', () => {
    const t = loadFactory().__test;
    const profile = t.validatePedalProfile({
        id: 'pedals',
        name: '  Pedals  ',
        pedals: [
            { id: 'hat-foot', surface: 'outline-top', label: 'Hat Foot', pieces: ['hh_pedal', 'snare'], color: '#22D3EE' },
            { id: 'kick-foot', surface: 'outline-bottom', label: 'BD', pieces: ['kick', 'kick'], color: '#FACC15' },
            { id: 'bad-surface', surface: 'outline-side', label: 'Bad', pieces: ['kick'] },
            { id: 'dup-surface', surface: 'outline-top', label: 'Dup', pieces: ['kick'] },
        ],
    });

    assert.equal(profile.id, 'pedals');
    assert.equal(profile.name, 'Pedals');
    assert.equal(profile.pedals.length, 2);
    assert.deepEqual(plain(profile.pedals.map(p => p.surface)), ['outline-top', 'outline-bottom']);
    assert.deepEqual(plain(profile.pedals.map(p => p.pieces)), [['hh_pedal'], ['kick']]);
    assert.equal(profile.pedals[0].color, '#22d3ee');
    assert.equal(profile.pedals[1].label, 'BD');
    // Pedals are no longer restricted to kick/hh_pedal - any piece is
    // assignable (same rule as pads and triggers).
    const anyPieceOnPedal = t.validatePedalProfile({ pedals: [{ surface: 'outline-top', pieces: ['snare'] }] });
    assert.equal(anyPieceOnPedal.pedals.length, 1);
    assert.deepEqual(plain(anyPieceOnPedal.pedals[0].pieces), ['snare']);

    const inactive = t.validatePedalProfile({ pedals: [{ surface: 'outline-top', pieces: ['bogus'] }] });
    assert.equal(inactive.pedals.length, 1);
    assert.deepEqual(plain(inactive.pedals[0].pieces), []);

    // Duplicate pedal-piece mappings are no longer allowed - a piece may be
    // assigned to at most one target total, so two pedals can no longer
    // both map to kick. The first pedal claims it; the second is left
    // unassigned instead of silently duplicating a target that would only
    // ever fire from one of them anyway (see projectDrumTab's routing
    // priority).
    const duplicateKick = t.validatePedalProfile({
        pedals: [
            { id: 'kick-a', surface: 'outline-bottom', pieces: ['kick'] },
            { id: 'kick-b', surface: 'outline-bottom', pieces: ['kick'] },
        ],
    });
    assert.deepEqual(plain(duplicateKick.pedals.map(p => p.pieces)), [['kick'], []]);

    const pedalMap = t.buildPieceToPedalMap(t.DEFAULT_PEDAL_PROFILE);
    assert.equal(pedalMap.hh_pedal.surface, 'outline-top');
    assert.equal(pedalMap.kick.surface, 'outline-bottom');
    assert.equal(t.DEFAULT_PEDAL_PROFILE.pedals[0].color, '#6bffe6');
    assert.equal(t.DEFAULT_PEDAL_PROFILE.pedals[1].color, '#ffa030');
});

test('validatePedalProfile falls back to the other surface when two pedals would otherwise collide', () => {
    // Regression guard: since any piece (not just hh_pedal/kick) can now be
    // assigned to a pedal, two pedals with different non-hh_pedal pieces
    // both default to 'outline-bottom' unless deduped - previously nothing
    // prevented this (unlike validateTriggerProfile's occupiedSurfaces).
    const t = loadFactory().__test;
    const profile = t.validatePedalProfile({
        pedals: [
            { id: 'a', pieces: ['snare'] },
            { id: 'b', pieces: ['tom_hi'] },
        ],
    });
    assert.deepEqual(plain(profile.pedals.map(p => p.surface)), ['outline-bottom', 'outline-top']);
    assert.deepEqual(plain(profile.pedals.map(p => p.pieces)), [['snare'], ['tom_hi']]);

    // An explicit surface request that collides with an earlier pedal is
    // also reassigned rather than silently duplicated.
    const explicit = t.validatePedalProfile({
        pedals: [
            { id: 'a', surface: 'outline-bottom', pieces: ['snare'] },
            { id: 'b', surface: 'outline-bottom', pieces: ['tom_hi'] },
        ],
    });
    assert.deepEqual(plain(explicit.pedals.map(p => p.surface)), ['outline-bottom', 'outline-top']);
});

test('kick assigned to a pad actually routes there', () => {
    // Regression guard: buildPieceToPadMap used to iterate PAD_PIECES
    // (non-pedal pieces only) to build its routed map, so even if
    // validatePadProfile accepted a direct kick assignment, the routing map
    // would never surface it and the hit would fall through to unrouted.
    const t = loadFactory().__test;
    const padProfile = t.validatePadProfile({
        id: 'kick-on-pad',
        name: 'Kick on pad',
        rows: 1,
        cols: 1,
        pads: [{ id: '1', row: 0, col: 0, pieces: ['kick'] }],
    });
    const routeMap = t.buildPieceToPadMap(padProfile);
    assert.equal(routeMap.kick.routeType, 'pad');
    assert.equal(routeMap.kick.pad.id, '1');

    const projected = t.projectDrumTab({
        hits: [{ t: 0, p: 'kick' }],
    }, { padProfile, pedalProfile: { pedals: [] }, triggerProfile: { triggers: [] } });
    assert.deepEqual(plain(projected.hitEvents.map(e => e.type)), ['pad']);
    assert.equal(projected.hitEvents[0].surfaceId, 'pad:1');
});

test('validateMultipadProfile enforces one target per piece across pad, pedal, and trigger', () => {
    // The user-facing rule: any piece may be assigned to a pad, a pedal, or
    // a trigger - but only one of them at a time, since a piece live on two
    // targets would only ever fire from one (projectDrumTab's pedal >
    // trigger > pad priority), leaving the other looking assigned but dead.
    // validateMultipadProfile is the combined-profile chokepoint that
    // enforces this: pad wins over pedal wins over trigger on conflict.
    const t = loadFactory().__test;

    const padProfile = {
        version: 1, id: 'p', name: 'p', rows: 1, cols: 1,
        pads: [{ id: '1', row: 0, col: 0, label: '', pieces: ['snare'], color: '#ffffff' }],
        fallbacks: {},
    };
    const pedalProfile = {
        version: 1, id: 'ped', name: 'ped',
        pedals: [{ id: 'a', surface: 'outline-top', label: '', pieces: ['snare'], color: '#ffffff' }],
    };
    const triggerProfile = {
        version: 1, id: 'trig', name: 'trig',
        triggers: [{ id: 't1', surface: 'outline-left', label: '', pieces: ['snare'], color: '#ffffff' }],
        triggerSlots: [],
    };

    const combined = t.validateMultipadProfile({ id: 'x', name: 'x', padProfile, pedalProfile, triggerProfile });
    // 'snare' is requested on all three - the pad (validated first) keeps
    // it, the pedal and trigger both lose it.
    assert.deepEqual(plain(combined.padProfile.pads[0].pieces), ['snare']);
    assert.deepEqual(plain(combined.pedalProfile.pedals[0].pieces), []);
    assert.deepEqual(plain(combined.triggerProfile.triggers[0].pieces), []);

    // Called standalone (not through validateMultipadProfile), each
    // validator only dedups within itself - no cross-profile knowledge - so
    // 'snare' survives in each independently.
    assert.deepEqual(plain(t.validatePadProfile(padProfile).pads[0].pieces), ['snare']);
    assert.deepEqual(plain(t.validatePedalProfile(pedalProfile).pedals[0].pieces), ['snare']);
    assert.deepEqual(plain(t.validateTriggerProfile(triggerProfile).triggers[0].pieces), ['snare']);
});

test('profileForPadLayout composes through validateMultipadProfile instead of a bare clone', () => {
    // Regression guard: profileForPadLayout used to hand-compose
    // {padProfile, pedalProfile, triggerProfile} via the plain clone*
    // helpers, bypassing validateMultipadProfile's cross-target piece
    // dedup entirely - the one profile-construction path not protected by
    // it. No BUILTIN_PAD_PROFILES entry currently assigns a pedal-claimed
    // piece, so this proves the routing itself (equivalence with directly
    // validating the same composition) rather than a live collision.
    const t = loadFactory().__test;
    const viaLayout = t.profileForPadLayout('generic-3x3');
    const viaDirectValidation = t.validateMultipadProfile({
        id: t.DEFAULT_PAD_PROFILE.id,
        name: t.DEFAULT_PAD_PROFILE.name,
        padProfile: t.DEFAULT_PAD_PROFILE,
        pedalProfile: t.DEFAULT_PEDAL_PROFILE,
        triggerProfile: t.DEFAULT_TRIGGER_PROFILE,
    });
    assert.deepEqual(plain(viaLayout), plain(viaDirectValidation));

    // Every known BUILTIN_PAD_PROFILES layout also satisfies the
    // one-target-per-piece invariant end to end.
    for (const layoutId of t.BUILTIN_PAD_PROFILE_IDS) {
        const profile = t.profileForPadLayout(layoutId);
        const seen = new Set();
        const collections = [profile.padProfile.pads, profile.pedalProfile.pedals, profile.triggerProfile.triggers];
        for (const entries of collections) {
            for (const entry of entries) {
                for (const piece of entry.pieces) {
                    assert.equal(seen.has(piece), false, `${layoutId}: '${piece}' assigned to more than one target`);
                    seen.add(piece);
                }
            }
        }
    }
});

test('collectAssignedPieces unions pieces across pad, pedal, and trigger, honoring skip predicates', () => {
    // This is the shared implementation settings.html's assignedElsewhere()
    // now delegates to via multipadH3dGetAssignedPieces, instead of settings.html
    // keeping its own independent copy of the same walk.
    const t = loadFactory().__test;
    const profile = {
        padProfile: { pads: [{ id: 'p1', pieces: ['snare', 'crash_l'] }] },
        pedalProfile: { pedals: [{ id: 'd1', pieces: ['kick'] }] },
        triggerProfile: { triggers: [{ id: 't1', surface: 'outline-left', pieces: ['tom_hi'] }] },
    };
    assert.deepEqual(
        Array.from(t.collectAssignedPieces(profile)).sort(),
        ['crash_l', 'kick', 'snare', 'tom_hi']
    );
    // skipPad excludes that pad's own pieces from the result.
    assert.deepEqual(
        Array.from(t.collectAssignedPieces(profile, { skipPad: p => p.id === 'p1' })).sort(),
        ['kick', 'tom_hi']
    );
    // Missing sub-profiles default to empty rather than throwing.
    assert.deepEqual(Array.from(t.collectAssignedPieces({})), []);
});

test('inactive pads remain visible but do not route notes', () => {
    const t = loadFactory().__test;
    const profile = t.validatePadProfile({
        id: 'inactive-grid',
        name: 'Inactive grid',
        rows: 1,
        cols: 2,
        pads: [
            { id: 'empty', row: 0, col: 0, pieces: [] },
            { id: 'snare-pad', row: 0, col: 1, pieces: ['snare'] },
        ],
    });
    assert.equal(profile.pads.length, 2);
    assert.deepEqual(plain(profile.pads[0].pieces), []);

    const layout = t.buildSurfaceLayout(profile, { pedals: [] }, { triggers: [] });
    const emptySurface = layout.surfaces.find(surface => surface.key === 'pad:empty');
    assert.equal(emptySurface.active, false);
    assert.equal(emptySurface.color, 0x2d3748);

    const projected = t.projectDrumTab({
        hits: [
            { t: 0, p: 'snare' },
            { t: 1, p: 'tom_hi' },
        ],
    }, { padProfile: profile, pedalProfile: { pedals: [] }, triggerProfile: { triggers: [] } });
    assert.deepEqual(plain(projected.hitEvents.map(event => event.piece)), ['snare']);
    assert.deepEqual(plain(projected.stats.unroutedPieces), { tom_hi: 1 });
});

test('projection stats expose zero-note routing failures', () => {
    const t = loadFactory().__test;
    const emptyProfile = t.validatePadProfile({
        id: 'empty-grid',
        name: 'Empty grid',
        rows: 1,
        cols: 1,
        pads: [
            { id: 'empty', row: 0, col: 0, pieces: [] },
        ],
    });
    const projected = t.projectDrumTab({
        hits: [
            { t: 0, p: 'snare' },
            { t: 0.5, p: 'hh_closed' },
            { t: 1, p: 'kick' },
        ],
    }, {
        padProfile: emptyProfile,
        pedalProfile: { pedals: [] },
        triggerProfile: { triggers: [] },
    });

    assert.equal(projected.hitEvents.length, 0);
    assert.equal(projected.stats.rawHits, 3);
    assert.equal(projected.stats.normalizedHits, 3);
    assert.equal(projected.stats.projectedHits, 0);
    assert.deepEqual(plain(projected.stats.unroutedPieces), {
        snare: 1,
        hh_closed: 1,
        kick: 1,
    });
});

test('variant classification ignores articulations for plain multipad hits', () => {
    const { hitVariant, normalizeTimingStatus } = loadFactory().__test;
    assert.equal(hitVariant({ g: true, f: true, v: 127 }), 'normal');
    assert.equal(hitVariant({ f: true, v: 127 }), 'normal');
    assert.equal(hitVariant({ p: 'ride_bell', v: 64 }), 'normal');
    assert.equal(hitVariant({ v: 100 }), 'normal');
    assert.equal(hitVariant({ v: 99 }), 'normal');
    assert.equal(hitVariant({}), 'normal');
    assert.equal(normalizeTimingStatus('early'), 'EARLY');
    assert.equal(normalizeTimingStatus('LATE'), 'LATE');
    assert.equal(normalizeTimingStatus('OK'), 'OK');
    assert.equal(normalizeTimingStatus('miss'), '');
});

test('chart projection normalizes hits, sorts by time, and preserves piece identity', () => {
    const t = loadFactory().__test;
    const projected = t.projectDrumTab({
        hits: [
            { t: 2, p: 'snare', v: 200 },
            { t: 1.506, p: 'stack', v: 90 },
            { t: 1.002, p: 'kick', v: 110 },
            { t: 1.003, p: 'hh_pedal', v: 90 },
            { t: 1.001, p: 'hh_open', v: 64 },
            { t: 1, p: 'hh_closed', g: true },
            { t: 0.5, p: 'ride_bell', v: 80 },
            { t: 0.75, p: 'bell', v: 80 },
            { t: 'bad', p: 'snare' },
            { t: 3, p: 'future_piece' },
        ],
    }, { hitGroupWindowSec: 0.008 });

    assert.deepEqual(plain(projected.hitEvents.map(e => e.piece)), ['ride_bell', 'bell', 'hh_closed', 'hh_open', 'kick', 'hh_pedal', 'stack', 'snare']);
    assert.deepEqual(plain(projected.hitEvents.map(e => e.type)), ['pad', 'pad', 'pad', 'pad', 'pedal', 'pedal', 'pad', 'pad']);
    assert.equal(projected.hitEvents[0].variant, 'normal');
    assert.equal(projected.hitEvents[1].variant, 'normal');
    assert.equal(projected.hitEvents[3].open, true);
    assert.equal(projected.hitEvents[0].surfaceId, 'pad:6');
    assert.equal(projected.hitEvents[1].surfaceId, 'pad:6');
    assert.equal(projected.hitEvents[4].surfaceId, 'outline-bottom');
    assert.equal(projected.hitEvents[5].surfaceId, 'outline-top');
    assert.equal(projected.hitEvents[6].surfaceId, 'pad:1');
    assert.equal(projected.hitEvents[7].velocity, 127);
    assert.equal(projected.stats.source, 'drumTab');
    assert.equal(projected.stats.rawHits, 10);
    assert.equal(projected.stats.normalizedHits, 8);
    assert.equal(projected.stats.projectedHits, 8);
    assert.equal(projected.stats.invalidHits, 1);
    assert.deepEqual(plain(projected.stats.unknownPieces), { future_piece: 1 });
    assert.deepEqual(plain(projected.stats.projectedPieces), {
        ride_bell: 1,
        bell: 1,
        hh_closed: 1,
        hh_open: 1,
        kick: 1,
        hh_pedal: 1,
        stack: 1,
        snare: 1,
    });

    const hihatEvents = projected.hitEvents.filter(e => e.type === 'pad' && e.piece.startsWith('hh_'));
    assert.equal(hihatEvents[0].padId, hihatEvents[1].padId);
    assert.notEqual(hihatEvents[0].piece, hihatEvents[1].piece);
});

test('hit groups collect same-window pad hits and pedal route surfaces', () => {
    const t = loadFactory().__test;
    const projected = t.projectDrumTab({
        hits: [
            { t: 10, p: 'snare' },
            { t: 10.004, p: 'kick' },
            { t: 10.005, p: 'hh_pedal' },
            { t: 10.007, p: 'crash_l' },
            { t: 10.020, p: 'ride' },
        ],
    }, { hitGroupWindowSec: 0.008 });

    assert.equal(projected.hitGroups.length, 2);
    assert.deepEqual(plain(projected.hitGroups[0].hitEvents.map(e => e.piece).sort()), ['crash_l', 'hh_pedal', 'kick', 'snare']);
    assert.equal(projected.hitGroups[0].hasKick, true);
    assert.equal(projected.hitGroups[0].hasHiHatPedal, true);
    assert.equal(projected.hitGroups[0].padIds.length, 2);
    assert.deepEqual(plain(projected.hitGroups[0].pedalSurfaces.sort()), ['outline-bottom', 'outline-top']);
    assert.equal(projected.hitGroups[1].hitEvents[0].piece, 'ride');
    assert.equal(projected.hitEvents[0].hitGroupId, 0);
});

test('hit events mark repeat per surface against the immediately previous group, independent of other members', () => {
    const t = loadFactory().__test;
    const projected = t.projectDrumTab({
        hits: [
            // G1 t=0: hi-hat alone - first group, nothing to repeat.
            { t: 0, p: 'hh_closed' },
            // G2 t=0.2: hi-hat alone again - genuine repeat.
            { t: 0.2, p: 'hh_closed' },
            // G3 t=0.4: snare joins. The hi-hat's own surface was still in
            // the previous group, so it stays "repeat" even though the
            // group's composition changed; snare is new, so it isn't.
            { t: 0.4, p: 'hh_closed' },
            { t: 0.4, p: 'snare' },
            // G4 t=0.6: back to hi-hat alone. The hi-hat was in G3's set too,
            // so it's still "repeat" - a second piece joining and leaving
            // doesn't interrupt the hi-hat's own streak.
            { t: 0.6, p: 'hh_closed' },
            // G5 t=0.8: snare alone. Snare wasn't in G4's set (just hi-hat),
            // so it's not a repeat.
            { t: 0.8, p: 'snare' },
            // G6 t=1.0: hi-hat alone. Hi-hat wasn't in G5's set (just
            // snare), so it's not a repeat either - the immediately previous
            // group is what's checked, not "the last group this piece
            // itself appeared in".
            { t: 1.0, p: 'hh_closed' },
        ],
    }, { hitGroupWindowSec: 0.008 });

    const repeatStateByTimePiece = Object.fromEntries(
        projected.hitEvents.map(event => [`${event.t}:${event.piece}`, !!event.repeatedFromPreviousGroup])
    );
    assert.equal(repeatStateByTimePiece['0:hh_closed'], false);
    assert.equal(repeatStateByTimePiece['0.2:hh_closed'], true);
    assert.equal(repeatStateByTimePiece['0.4:hh_closed'], true);
    assert.equal(repeatStateByTimePiece['0.4:snare'], false);
    assert.equal(repeatStateByTimePiece['0.6:hh_closed'], true);
    assert.equal(repeatStateByTimePiece['0.8:snare'], false);
    assert.equal(repeatStateByTimePiece['1:hh_closed'], false);
});

test('custom profile fallbacks route missing pieces without redefining drum ids', () => {
    const t = loadFactory().__test;
    const profile = t.validatePadProfile({
        id: 'tiny',
        name: 'Tiny',
        rows: 1,
        cols: 5,
        pads: [
            { row: 0, col: 0, pieces: ['hh_closed'] },
            { row: 0, col: 1, pieces: ['snare'] },
            { row: 0, col: 2, pieces: ['tom_mid'] },
            { row: 0, col: 3, pieces: ['crash_l'] },
            { row: 0, col: 4, pieces: ['ride'] },
        ],
        fallbacks: {
            hh_open: 'hh_closed',
            snare_xstick: 'snare',
            tom_low: 'tom_mid',
            crash_r: 'crash_l',
            splash: 'crash_l',
            china: 'crash_l',
            stack: 'crash_l',
            ride_bell: 'ride',
            bell: 'ride',
        },
    });
    const projected = t.projectDrumTab({
        hits: [
            { t: 0, p: 'hh_open' },
            { t: 1, p: 'snare_xstick' },
            { t: 2, p: 'tom_low' },
            { t: 3, p: 'crash_r' },
            { t: 4, p: 'splash' },
            { t: 5, p: 'china' },
            { t: 6, p: 'ride_bell' },
            { t: 7, p: 'stack' },
            { t: 8, p: 'bell' },
            { t: 9, p: 'tom_floor' },
        ],
    }, { padProfile: profile });

    assert.deepEqual(plain(projected.hitEvents.map(e => e.piece)), [
        'hh_open',
        'snare_xstick',
        'tom_low',
        'crash_r',
        'splash',
        'china',
        'ride_bell',
        'stack',
        'bell',
    ]);
    assert.deepEqual(plain(projected.hitEvents.map(e => e.routedPiece)), [
        'hh_closed',
        'snare',
        'tom_mid',
        'crash_l',
        'crash_l',
        'crash_l',
        'ride',
        'crash_l',
        'ride',
    ]);
});

test('settings survive missing and corrupt localStorage', () => {
    const noStorage = loadFactory().__test;
    assert.deepEqual(noStorage.readSettings(), noStorage.DEFAULT_SETTINGS);

    const { factory, store } = loadFactoryWithStorage({
        multipad_h3d_pad_profile: 'unknown',
        multipad_h3d_pedal_profile: 'generic-pedals',
        multipad_h3d_trigger_profile: 'generic-triggers',
        multipad_h3d_show_labels: '0',
        multipad_h3d_hit_group_window_ms: '999',
        multipad_h3d_camera_angle: '2',
        multipad_h3d_scene_theme: 'forest',
        multipad_h3d_glow_strength: '-1',
        multipad_h3d_feedback_intensity: '0.25',
        multipad_h3d_timing_colors: '0',
        multipad_h3d_hit_sparks: 'false',
        multipad_h3d_cinematic_lighting: '1',
        multipad_h3d_background_style: 'lights',
        multipad_h3d_background_intensity: '2',
    });
    const settings = factory.__test.readSettings();
    assert.equal(settings.padProfileId, 'generic-3x3');
    assert.equal(settings.pedalProfileId, 'generic-pedals');
    assert.equal(settings.triggerProfileId, 'generic-triggers');
    assert.equal(settings.showLabels, false);
    assert.equal(settings.hitGroupWindowMs, 50);
    assert.equal(settings.cameraAngle, 1);
    assert.equal(settings.sceneTheme, 'forest');
    assert.equal(settings.glowStrength, 0);
    assert.equal(settings.feedbackIntensity, 0.25);
    assert.equal(settings.timingColors, false);
    assert.equal(settings.hitSparks, false);
    assert.equal(settings.cinematicLighting, true);
    assert.equal(settings.backgroundStyle, 'lights');
    assert.equal(settings.backgroundIntensity, 1);

    factory.__test.writeSetting('hitGroupWindowMs', -1);
    factory.__test.writeSetting('showLabels', true);
    factory.__test.writeSetting('timingColors', true);
    factory.__test.writeSetting('hitSparks', true);
    factory.__test.writeSetting('cinematicLighting', false);
    factory.__test.writeSetting('backgroundStyle', 'geometric');
    factory.__test.writeSetting('backgroundIntensity', -1);
    factory.__test.writeSetting('cameraAngle', 0.65);
    factory.__test.writeSetting('sceneTheme', 'charcoal');
    factory.__test.writeSetting('glowStrength', 1.5);
    factory.__test.writeSetting('feedbackIntensity', -1);
    assert.equal(store.get('multipad_h3d_hit_group_window_ms'), '0');
    assert.equal(store.get('multipad_h3d_show_labels'), '1');
    assert.equal(store.get('multipad_h3d_timing_colors'), '1');
    assert.equal(store.get('multipad_h3d_hit_sparks'), '1');
    assert.equal(store.get('multipad_h3d_cinematic_lighting'), '0');
    assert.equal(store.get('multipad_h3d_background_style'), 'geometric');
    assert.equal(store.get('multipad_h3d_background_intensity'), '0');
    assert.equal(store.get('multipad_h3d_camera_angle'), '0.65');
    assert.equal(store.get('multipad_h3d_scene_theme'), 'charcoal');
    assert.equal(store.get('multipad_h3d_glow_strength'), '1');
    assert.equal(store.get('multipad_h3d_feedback_intensity'), '0');

    const legacy = loadFactoryWithStorage({ multipad_h3d_background_ambience: '0' });
    assert.equal(legacy.factory.__test.readSettings().backgroundStyle, 'off');
});

test('profile API exposes phase five layout choices and persists saved defaults', () => {
    const { factory, store } = loadFactoryWithStorage();
    const layouts = factory.__test.BUILTIN_PAD_PROFILE_IDS;
    assert.deepEqual(plain(layouts), ['generic-3x3', 'generic-2x4', 'generic-4x3', 'custom']);

    const profile = factory.__test.readMultipadProfile();
    profile.id = 'phase-five';
    profile.name = 'Phase Five';
    profile.padProfile = factory.__test.validatePadProfile({
        id: 'custom',
        name: 'Custom',
        rows: 2,
        cols: 2,
        pads: [
            { id: '1', row: 0, col: 0, pieces: ['snare'], color: '#ff2828' },
            { id: '4', row: 1, col: 1, pieces: [], color: '#2d3748' },
        ],
    });
    // Both pedals request 'kick' - only the first keeps it (duplicate
    // pedal-piece mappings are no longer allowed).
    profile.pedalProfile = factory.__test.validatePedalProfile({
        id: 'pedals',
        name: 'Kick + unassigned',
        pedals: [
            { id: 'left', surface: 'outline-bottom', pieces: ['kick'], color: '#ffa030' },
            { id: 'right', surface: 'outline-bottom', pieces: ['kick'], color: '#ffa030' },
        ],
    });
    profile.triggerProfile = factory.__test.validateTriggerProfile({
        id: 'triggers',
        name: 'One dual trigger',
        triggerSlots: [
            { id: 'trigger-1', zones: 2 },
        ],
        triggers: [
            { id: 't1-center', surface: 'external-left-center', pieces: ['tom_hi'], color: '#30d040' },
            { id: 't1-edge', surface: 'external-left-edge', pieces: [], color: '#2d3748' },
        ],
    });

    assert.equal(factory.__test.writeMultipadProfile(profile), true);
    assert.ok(store.get('multipad_h3d_profile_v1'));
    const saved = factory.__test.readMultipadProfile();
    assert.equal(saved.id, 'phase-five');
    assert.equal(saved.padProfile.rows, 2);
    assert.deepEqual(plain(saved.pedalProfile.pedals.map(pedal => pedal.pieces)), [['kick'], []]);
    assert.deepEqual(plain(saved.triggerProfile.triggers.map(trigger => trigger.pieces)), [['tom_hi'], []]);
    assert.deepEqual(plain(saved.triggerProfile.triggerSlots), [{ id: 'trigger-1', zones: 2 }]);
});

test('profile API persists a 3-zone trigger profile round trip', () => {
    const { factory, store } = loadFactoryWithStorage();

    const profile = factory.__test.readMultipadProfile();
    profile.id = 'triple-zone';
    profile.name = 'Triple Zone';
    // Swap in a pad profile that doesn't already claim tom_hi/snare_xstick/
    // tom_mid (the default pad profile does) - a piece can only be assigned
    // to one target across the whole combined profile, and pad validates
    // before trigger, so leaving the default pad profile in place would
    // silently strip these from the trigger below.
    profile.padProfile = factory.__test.validatePadProfile({
        id: 'custom',
        name: 'Custom',
        rows: 1,
        cols: 1,
        pads: [{ id: '1', row: 0, col: 0, pieces: [] }],
    });
    profile.triggerProfile = factory.__test.validateTriggerProfile({
        id: 'triggers-3',
        name: 'One triple trigger',
        triggerSlots: [
            { id: 'trigger-1', zones: 3 },
        ],
        triggers: [
            { id: 't1-center', surface: 'external-left-center', pieces: ['tom_hi'], color: '#30d040' },
            { id: 't1-edge', surface: 'external-left-edge', pieces: ['snare_xstick'], color: '#facc15' },
            { id: 't1-rim', surface: 'external-left-rim', pieces: ['tom_mid'], color: '#f87171' },
        ],
    });

    assert.equal(factory.__test.writeMultipadProfile(profile), true);
    assert.ok(store.get('multipad_h3d_profile_v1'));
    const saved = factory.__test.readMultipadProfile();
    assert.equal(saved.id, 'triple-zone');
    assert.deepEqual(plain(saved.triggerProfile.triggers.map(trigger => trigger.surface)), [
        'external-left-center',
        'external-left-edge',
        'external-left-rim',
    ]);
    assert.deepEqual(plain(saved.triggerProfile.triggers.map(trigger => trigger.pieces)), [['tom_hi'], ['snare_xstick'], ['tom_mid']]);
    assert.deepEqual(plain(saved.triggerProfile.triggerSlots), [{ id: 'trigger-1', zones: 3 }]);
});

test('projectGridPoint converges the grid center toward the vanishing point while keeping local offsets unscaled', () => {
    const t = loadFactory().__test;

    // progress=1 (at the target plane): the grid center is exactly its
    // real position, and a local offset lands at its exact real spot -
    // this is the "arrived" case both a pad and the outline must hit
    // exactly, with no residual compression.
    assert.deepEqual(plain(t.projectGridPoint(0, 0, 1)), { x: 0, y: t.GRID_CENTER_Y });
    assert.deepEqual(plain(t.projectGridPoint(1.34, 0.94, 1)), { x: 1.34, y: t.GRID_CENTER_Y + 0.94 });

    // progress=0 (just spawned): the grid center sits at the compressed
    // back/vanishing point - but a local offset is still added in FULL,
    // not scaled down. This is the exact invariant the "gem sat near the
    // outline's center instead of its own proportional spot" bug broke:
    // offsets must never shrink toward zero at low progress.
    assert.deepEqual(plain(t.projectGridPoint(0, 0, 0)), { x: t.TUNNEL_BACK_X_OFFSET, y: t.GRID_CENTER_Y + t.TUNNEL_BACK_LIFT });
    assert.deepEqual(plain(t.projectGridPoint(1.34, 0.94, 0)), { x: t.TUNNEL_BACK_X_OFFSET + 1.34, y: t.GRID_CENTER_Y + t.TUNNEL_BACK_LIFT + 0.94 });

    // At any progress, two points that share the same offset stay exactly
    // that offset apart - the center converges, the spread around it
    // doesn't, at every point along the path, not just the endpoints.
    for (const progress of [0, 0.25, 0.5, 0.75, 1]) {
        const a = t.projectGridPoint(0, 0, progress);
        const b = t.projectGridPoint(1.34, 0.94, progress);
        assert.ok(Math.abs((b.x - a.x) - 1.34) < 1e-9, `progress=${progress}`);
        assert.ok(Math.abs((b.y - a.y) - 0.94) < 1e-9, `progress=${progress}`);
    }
});

test('pastThresholdOpacity ramps linearly from the pre-crossing opacity to fully invisible', () => {
    const t = loadFactory().__test;

    // The instant a note crosses (secSinceCrossing=0), it still shows its
    // full pre-crossing opacity - only the color has snapped, not the
    // transparency.
    assert.equal(t.pastThresholdOpacity(0.82, 0), 0.82);
    assert.equal(t.pastThresholdOpacity(0.24, 0), 0.24);

    // Linear ramp: at the halfway point of the fade window, opacity is
    // exactly half of where it started.
    const half = t.NOTE_PAST_THRESHOLD_FADE_SEC / 2;
    assert.ok(Math.abs(t.pastThresholdOpacity(0.82, half) - 0.41) < 1e-9);

    // Fully invisible at (and beyond) the fade duration - never negative.
    assert.equal(t.pastThresholdOpacity(0.82, t.NOTE_PAST_THRESHOLD_FADE_SEC), 0);
    assert.equal(t.pastThresholdOpacity(0.82, t.NOTE_PAST_THRESHOLD_FADE_SEC * 4), 0);

    // The fade window itself defaults to something in the 200-300ms
    // ballpark the feature was asked for ("something like 250ms").
    assert.ok(t.NOTE_PAST_THRESHOLD_FADE_SEC >= 0.2 && t.NOTE_PAST_THRESHOLD_FADE_SEC <= 0.3);

    // NOTE_BEHIND_SEC (when a past-threshold note stops being drawn/culled
    // entirely) must be at least as long as the fade, or the gem would pop
    // out of existence mid-fade instead of reaching fully invisible first.
    assert.ok(t.NOTE_BEHIND_SEC >= t.NOTE_PAST_THRESHOLD_FADE_SEC);
});

test('every default-profile pad stays within the layout-preview outline at every travel progress', () => {
    // Regression guard for the class of bug this session hit three times:
    // note-gem placement and the whole-hit-group outline each hand-rolling
    // their own version of the same tunnel-projection formula, and drifting
    // out of sync. Both now route through the single projectGridPoint
    // helper, so this should hold by construction - this test exists to
    // catch a future edit that reintroduces a second, diverging formula at
    // either call site instead of updating projectGridPoint itself.
    const t = loadFactory().__test;
    const layout = t.buildSurfaceLayout(t.DEFAULT_PAD_PROFILE);
    const halfW = layout.gridW / 2;
    const halfH = layout.gridH / 2;
    const pads = layout.surfaces.filter(surface => surface.key.startsWith('pad:'));
    assert.ok(pads.length > 0);

    for (const progress of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
        const center = t.projectGridPoint(0, 0, progress);
        for (const pad of pads) {
            const point = t.projectGridPoint(pad.x, pad.y - t.GRID_CENTER_Y, progress);
            assert.ok(
                Math.abs(point.x - center.x) <= halfW + 1e-9,
                `pad ${pad.key} x=${point.x} outside outline half-width ${halfW} at progress=${progress}`
            );
            assert.ok(
                Math.abs(point.y - center.y) <= halfH + 1e-9,
                `pad ${pad.key} y=${point.y} outside outline half-height ${halfH} at progress=${progress}`
            );
        }
    }
});
