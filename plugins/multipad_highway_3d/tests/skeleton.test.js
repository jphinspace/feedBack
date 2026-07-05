const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const PLUGIN_DIR = path.join(ROOT, 'plugins', 'multipad_highway_3d');

function loadFactory() {
    const window = {
        console,
        slopsmith: {},
    };
    window.window = window;
    window.globalThis = window;
    const context = vm.createContext(window);
    const src = fs.readFileSync(path.join(PLUGIN_DIR, 'screen.js'), 'utf8');
    vm.runInContext(src, context, { filename: 'screen.js' });
    return window.feedBackViz_multipad_highway_3d;
}

function loadFactoryWithStorage(entries = {}) {
    const store = new Map(Object.entries(entries));
    const window = {
        console,
        slopsmith: {},
        localStorage: {
            getItem(key) {
                return store.has(key) ? store.get(key) : null;
            },
            setItem(key, value) {
                store.set(key, String(value));
            },
        },
    };
    window.window = window;
    window.globalThis = window;
    const context = vm.createContext(window);
    const src = fs.readFileSync(path.join(PLUGIN_DIR, 'screen.js'), 'utf8');
    vm.runInContext(src, context, { filename: 'screen.js' });
    return { factory: window.feedBackViz_multipad_highway_3d, store };
}

function plain(value) {
    return JSON.parse(JSON.stringify(value));
}

test('manifest declares a visualization-only bundled plugin', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, 'plugin.json'), 'utf8'));
    assert.equal(manifest.id, 'multipad_highway_3d');
    assert.equal(manifest.type, 'visualization');
    assert.equal(manifest.bundled, true);
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

test('factory registers with a no-op 2d renderer and no auto-claim', () => {
    const factory = loadFactory();
    assert.equal(typeof factory, 'function');
    assert.equal(factory.contextType, '2d');
    assert.equal(factory.matchesArrangement({ has_drum_tab: true, arrangement: 'Drums' }), false);
    assert.equal(factory.__test.pluginId, 'multipad_highway_3d');
});

test('renderer lifecycle clears canvas and tears down idempotently', () => {
    const factory = loadFactory();
    const ops = [];
    const ctx = {
        clearRect(x, y, w, h) {
            ops.push(['clearRect', x, y, w, h]);
        },
    };
    const canvas = {
        width: 640,
        height: 360,
        clientWidth: 640,
        clientHeight: 360,
        getContext(type) {
            ops.push(['getContext', type]);
            return ctx;
        },
    };

    const renderer = factory();
    assert.equal(renderer.contextType, '2d');
    renderer.init(canvas, { currentTime: 0 });
    renderer.draw({ currentTime: 1 });
    renderer.resize(320, 180);
    assert.deepEqual(JSON.parse(JSON.stringify(renderer.__probe())), {
        pluginId: 'multipad_highway_3d',
        contextType: '2d',
        initialized: true,
        width: 320,
        height: 180,
        hasBundle: true,
    });
    renderer.destroy();
    renderer.destroy();

    assert.deepEqual(ops[0], ['getContext', '2d']);
    assert.equal(ops.filter(op => op[0] === 'clearRect').length >= 3, true);
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
            { row: 0, col: 1, label: 'B', pieces: ['tom_hi', 'snare'] },
            { row: 9, col: 9, pieces: ['ride'] },
        ],
        fallbacks: {
            tom_low: 'tom_hi',
            __proto__: 'snare',
        },
    });

    assert.equal(profile.id, 'yamaha-4x3');
    assert.equal(profile.name, 'Yamaha style');
    assert.equal(profile.rows, 4);
    assert.equal(profile.cols, 3);
    assert.equal(profile.pads.length, 2);
    assert.deepEqual(plain(profile.pads[0].pieces), ['snare']);
    assert.deepEqual(plain(profile.pads[1].pieces), ['tom_hi']);
    assert.equal(profile.fallbacks.tom_low, 'tom_hi');
    assert.equal({}.polluted, undefined);
});

test('default pad profile routes every known pad piece somewhere', () => {
    const t = loadFactory().__test;
    const routeMap = t.buildPieceToPadMap(t.DEFAULT_PAD_PROFILE);
    for (const piece of t.PAD_PIECES) {
        assert.ok(routeMap[piece], piece);
        assert.equal(routeMap[piece].pad.id.startsWith('r'), true);
    }
    assert.equal(routeMap.kick, undefined);
    assert.equal(routeMap.hh_pedal, undefined);
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

test('pedal profile validation supports kick and hi-hat pedal indicators', () => {
    const t = loadFactory().__test;
    const profile = t.validatePedalProfile({
        id: 'pedals',
        name: '  Pedals  ',
        pedals: [
            { id: 'hat-foot', indicator: 'outline-top', label: 'Hat Foot', pieces: ['hh_pedal', 'snare'], color: '#22D3EE' },
            { id: 'kick-foot', indicator: 'outline-bottom', label: 'BD', pieces: ['kick', 'kick'], color: '#FACC15' },
            { id: 'bad-indicator', indicator: 'outline-side', label: 'Bad', pieces: ['kick'] },
            { id: 'dup-indicator', indicator: 'outline-top', label: 'Dup', pieces: ['kick'] },
        ],
    });

    assert.equal(profile.id, 'pedals');
    assert.equal(profile.name, 'Pedals');
    assert.equal(profile.pedals.length, 2);
    assert.deepEqual(plain(profile.pedals.map(p => p.indicator)), ['outline-top', 'outline-bottom']);
    assert.deepEqual(plain(profile.pedals.map(p => p.pieces)), [['hh_pedal'], ['kick']]);
    assert.equal(profile.pedals[0].color, '#22d3ee');
    assert.equal(profile.pedals[1].label, 'BD');
    assert.equal(t.validatePedalProfile({ pedals: [{ indicator: 'outline-top', pieces: ['snare'] }] }), null);

    const pedalMap = t.buildPieceToPedalMap(t.DEFAULT_PEDAL_PROFILE);
    assert.equal(pedalMap.hh_pedal.indicator, 'outline-top');
    assert.equal(pedalMap.kick.indicator, 'outline-bottom');
});

test('variant classification mirrors drum highway precedence', () => {
    const { hitVariant } = loadFactory().__test;
    assert.equal(hitVariant({ g: true, f: true, v: 127 }), 'ghost');
    assert.equal(hitVariant({ f: true, v: 127 }), 'flam');
    assert.equal(hitVariant({ p: 'ride_bell', v: 64 }), 'bell');
    assert.equal(hitVariant({ v: 100 }), 'accent');
    assert.equal(hitVariant({ v: 99 }), 'normal');
    assert.equal(hitVariant({}), 'accent');
});

test('chart projection normalizes hits, sorts by time, and preserves piece identity', () => {
    const t = loadFactory().__test;
    const projected = t.projectDrumTab({
        hits: [
            { t: 2, p: 'snare', v: 200 },
            { t: 1.002, p: 'kick', v: 110 },
            { t: 1.003, p: 'hh_pedal', v: 90 },
            { t: 1.001, p: 'hh_open', v: 64 },
            { t: 1, p: 'hh_closed', g: true },
            { t: 0.5, p: 'ride_bell', v: 80 },
            { t: 'bad', p: 'snare' },
            { t: 3, p: 'future_piece' },
        ],
    }, { hitGroupWindowSec: 0.008 });

    assert.deepEqual(plain(projected.hitEvents.map(e => e.piece)), ['ride_bell', 'hh_closed', 'hh_open', 'kick', 'hh_pedal', 'snare']);
    assert.deepEqual(plain(projected.hitEvents.map(e => e.type)), ['pad', 'pad', 'pad', 'pedal', 'pedal', 'pad']);
    assert.equal(projected.hitEvents[0].variant, 'bell');
    assert.equal(projected.hitEvents[1].variant, 'ghost');
    assert.equal(projected.hitEvents[2].open, true);
    assert.equal(projected.hitEvents[3].indicator, 'outline-bottom');
    assert.equal(projected.hitEvents[4].indicator, 'outline-top');
    assert.equal(projected.hitEvents[5].velocity, 127);

    const hihatEvents = projected.hitEvents.filter(e => e.type === 'pad' && e.piece.startsWith('hh_'));
    assert.equal(hihatEvents[0].padId, hihatEvents[1].padId);
    assert.notEqual(hihatEvents[0].piece, hihatEvents[1].piece);
});

test('hit groups collect same-window pad hits and pedal indicator pulses', () => {
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
    assert.deepEqual(plain(projected.hitGroups[0].pedalIndicators.sort()), ['outline-bottom', 'outline-top']);
    assert.equal(projected.hitGroups[1].hitEvents[0].piece, 'ride');
    assert.equal(projected.hitEvents[0].hitGroupId, 0);
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
            ride_bell: 'ride',
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
            { t: 7, p: 'tom_floor' },
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
    ]);
    assert.deepEqual(plain(projected.hitEvents.map(e => e.routedPiece)), [
        'hh_closed',
        'snare',
        'tom_mid',
        'crash_l',
        'crash_l',
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
        multipad_h3d_show_labels: '0',
        multipad_h3d_hit_group_window_ms: '999',
    });
    const settings = factory.__test.readSettings();
    assert.equal(settings.padProfileId, 'generic-3x3');
    assert.equal(settings.pedalProfileId, 'generic-pedals');
    assert.equal(settings.showLabels, false);
    assert.equal(settings.hitGroupWindowMs, 50);

    factory.__test.writeSetting('hitGroupWindowMs', -1);
    factory.__test.writeSetting('showLabels', true);
    assert.equal(store.get('multipad_h3d_hit_group_window_ms'), '0');
    assert.equal(store.get('multipad_h3d_show_labels'), '1');
});
