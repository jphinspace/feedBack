// Multipad Highway 3D visualization plugin.
//
// Phase 2 skeleton: register the host visualization factory and provide a
// clean no-op renderer lifecycle. Real pad projection and WebGL rendering land
// in later phases from PLANNING.md.

(function () {
    'use strict';

    const PLUGIN_ID = 'multipad_highway_3d';
    const CONTEXT_TYPE = '2d';
    const liveInstances = new Set();

    function matchesArrangement(_songInfo) {
        // The Phase 2 renderer is intentionally no-op, so Auto mode should not
        // select it yet. Manual picker selection still exercises the lifecycle.
        return false;
    }

    function createFactory() {
        let canvas = null;
        let ctx = null;
        let lastBundle = null;
        let lastWidth = 0;
        let lastHeight = 0;
        let destroyed = false;

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
