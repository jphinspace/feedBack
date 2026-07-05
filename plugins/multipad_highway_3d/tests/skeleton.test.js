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
