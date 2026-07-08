const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createThreeStub } = require('./three-stub');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const PLUGIN_DIR = path.join(ROOT, 'plugins', 'multipad_highway_3d');

function loadFactoryHarness(options = {}) {
    const window = {
        console,
    };
    if (options.localStorage) window.localStorage = options.localStorage;
    if (options.standardDrumHighway) window.feedBackViz_drum_highway_3d = function () {};
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

function loadFactoryWithStorage(entries = {}) {
    const store = new Map(Object.entries(entries));
    const factory = loadFactoryHarness({
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
    assert.deepEqual(plain(profile.pads[0].pieces), ['snare']);
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
        triggers: [
            { id: 'snare-in', surface: 'outline-left', label: 'Ext Snare', pieces: ['snare', 'kick'], color: '#A78BFA' },
            { id: 'bad', surface: 'outline-right', label: 'Bad', pieces: ['bogus'] },
            { id: 'dup-surface', surface: 'outline-left', label: 'Dup', pieces: ['tom_hi'] },
        ],
    });

    assert.equal(profile.id, 'external-triggers');
    assert.equal(profile.name, 'External snare');
    assert.deepEqual(plain(profile.triggers.map(t => t.id)), ['snare-in', 'bad']);
    assert.deepEqual(plain(profile.triggers[0].pieces), ['snare']);
    assert.deepEqual(plain(profile.triggers[1].pieces), []);
    assert.equal(profile.triggers[0].surface, 'outline-left');
    assert.equal(profile.triggers[0].color, '#a78bfa');
    assert.equal(t.colorHexFromCss(profile.triggers[0].color), 0xa78bfa);
    assert.equal(t.colorHexFromCss('not-a-color'), null);
    assert.deepEqual(plain(t.DEFAULT_TRIGGER_PROFILE.triggers), []);

    const triggerMap = t.buildPieceToTriggerMap(profile);
    assert.equal(triggerMap.snare.id, 'snare-in');
    assert.equal(triggerMap.kick, undefined);

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
    const inactive = t.validatePedalProfile({ pedals: [{ surface: 'outline-top', pieces: ['snare'] }] });
    assert.equal(inactive.pedals.length, 1);
    assert.deepEqual(plain(inactive.pedals[0].pieces), []);

    const duplicateKick = t.validatePedalProfile({
        pedals: [
            { id: 'kick-a', surface: 'outline-bottom', pieces: ['kick'] },
            { id: 'kick-b', surface: 'outline-bottom', pieces: ['kick'] },
        ],
    });
    assert.deepEqual(plain(duplicateKick.pedals.map(p => p.pieces)), [['kick'], ['kick']]);

    const pedalMap = t.buildPieceToPedalMap(t.DEFAULT_PEDAL_PROFILE);
    assert.equal(pedalMap.hh_pedal.surface, 'outline-top');
    assert.equal(pedalMap.kick.surface, 'outline-bottom');
    assert.equal(t.DEFAULT_PEDAL_PROFILE.pedals[0].color, '#6bffe6');
    assert.equal(t.DEFAULT_PEDAL_PROFILE.pedals[1].color, '#ffa030');
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
    profile.pedalProfile = factory.__test.validatePedalProfile({
        id: 'pedals',
        name: 'Two kicks',
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
    assert.deepEqual(plain(saved.pedalProfile.pedals.map(pedal => pedal.pieces)), [['kick'], ['kick']]);
    assert.deepEqual(plain(saved.triggerProfile.triggers.map(trigger => trigger.pieces)), [['tom_hi'], []]);
    assert.deepEqual(plain(saved.triggerProfile.triggerSlots), [{ id: 'trigger-1', zones: 2 }]);
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
