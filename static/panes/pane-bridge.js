/*
 * fee[dB]ack — pane bridge.
 *
 * The transport + context layer for detachable panes. Zero DOM, zero UI.
 *
 * A pane is authored ONCE, as `mount(root, ctx)`, and must run unchanged in two
 * places: docked in the main window, or inside a pop-out window (a separate JS
 * realm where `window.feedBack`, `window.highway` and the audio graph do not
 * exist). Everything a pane is allowed to touch therefore arrives through `ctx`
 * — never through globals. That is the whole point of this file: it is the only
 * seam between "pane code" and "which realm am I in".
 *
 * Two transports implement that seam:
 *
 *   LocalTransport  — main realm. Calls straight through to the capability bus,
 *                     the feedBack event bus, and the stream sampler.
 *   RemoteTransport — pane realm (added with the pop-out window). Same methods,
 *                     marshalled over BroadcastChannel.
 *
 * A pane cannot tell them apart, and must not try.
 *
 * Exposes `window.__fbPaneBridge` (host-internal — panes never touch it).
 */
(function () {
    'use strict';

    // Bumped only on a breaking envelope change. The pane realm refuses to talk
    // to a main realm with a different major, rather than half-working.
    const PROTOCOL_VERSION = 1;
    const CHANNEL_NAME = 'feedback-panes';

    // Bus events mirrored into a pane realm by default. Deliberately an
    // allowlist, not a firehose: `song:position-changed` fires every 250ms and
    // `capability:event` fires constantly, and neither belongs on a
    // cross-window channel — position rides the `playhead` stream instead.
    // A pane widens this with `spec.events: [...]`.
    const DEFAULT_EVENTS = [
        'song:loading', 'song:loaded', 'song:ready',
        'song:play', 'song:pause', 'song:ended', 'song:stop', 'song:seek',
        'song:arrangement-changed',
        'screen:changed', 'theme:changed', 'library:changed',
        'highway:canvas-replaced', 'highway:visibility',
    ];

    // ── State store ──────────────────────────────────────────────────────────
    // A dotted-path key/value tree, one per pane. In the main realm this is the
    // authoritative copy; a pane realm holds a replica and its writes are
    // requests (see RemoteTransport). Subscribers get (snapshot, change).

    function _split(path) {
        if (typeof path !== 'string' || !path) throw new TypeError('pane state: path must be a non-empty string');
        return path.split('.');
    }

    function createStateStore(initial) {
        let data = (initial && typeof initial === 'object') ? JSON.parse(JSON.stringify(initial)) : {};
        const subs = new Set();

        function get(path) {
            if (path == null) return data;
            let node = data;
            for (const k of _split(path)) {
                if (node == null || typeof node !== 'object') return undefined;
                node = node[k];
            }
            return node;
        }

        function set(path, value) {
            const keys = _split(path);
            let node = data;
            for (let i = 0; i < keys.length - 1; i++) {
                const k = keys[i];
                // Walk-and-create. A non-object on the way down is replaced —
                // the writer's shape wins over a stale scalar.
                if (node[k] == null || typeof node[k] !== 'object') node[k] = {};
                node = node[k];
            }
            const last = keys[keys.length - 1];
            if (node[last] === value) return false;   // no-op writes don't notify
            node[last] = value;
            const change = { path: path, value: value };
            subs.forEach((fn) => { try { fn(data, change); } catch (e) { console.error('[panes] state subscriber threw', e); } });
            return true;
        }

        // Bulk replace, used on snapshot/resync. Notifies once with a null change.
        function replace(next) {
            data = (next && typeof next === 'object') ? next : {};
            subs.forEach((fn) => { try { fn(data, null); } catch (e) { console.error('[panes] state subscriber threw', e); } });
        }

        function subscribe(fn) {
            subs.add(fn);
            return () => subs.delete(fn);
        }

        return { get, set, replace, subscribe, all: () => data };
    }

    // ── Local transport (main realm) ─────────────────────────────────────────

    const CALL_TIMEOUT_MS = 2100;   // matches core's own audio-mix calls

    function createLocalTransport(paneId) {
        return {
            kind: 'local',

            // Route to the capability bus. Panes get exactly this, and nothing
            // else, as their door into app services — so a pane written against
            // ctx.call() keeps working when it moves realms.
            //
            // A pane passes a plain PAYLOAD; the requester/origin/timeout
            // envelope is core's to build. That keeps the pane-side call
            // identical in both realms, where the remote transport has to
            // reconstruct the envelope on this side of the channel anyway.
            call(domain, command, payload) {
                const caps = window.feedBack && window.feedBack.capabilities;
                if (!caps || typeof caps.command !== 'function') {
                    return Promise.reject(new Error('pane ctx.call: capability bus unavailable'));
                }
                return caps.command(domain, command, {
                    requester: 'pane.' + paneId,
                    origin: 'pane',
                    payload: payload || {},
                    timeoutMs: CALL_TIMEOUT_MS,
                });
            },

            on(name, fn) {
                const bus = window.feedBack;
                if (!bus || typeof bus.on !== 'function') return () => {};
                bus.on(name, fn);
                return () => bus.off(name, fn);
            },

            subscribe(stream, fn) {
                const s = window.__fbPaneStreams;
                if (!s) return () => {};
                return s.subscribe(stream, fn);
            },

            // In the main realm the clock needs no interpolation — the highway's
            // own time IS the source of truth. (The pane realm has to
            // extrapolate; see RemoteTransport, added with the pop-out window.)
            playhead() {
                const hw = window.highway;
                const t = (hw && typeof hw.getTime === 'function') ? hw.getTime() : NaN;
                return Number.isFinite(t) ? t : 0;
            },

            song() {
                return (window.feedBack && window.feedBack.currentSong) || null;
            },

            toast(opts) {
                if (window.fbNotify && typeof window.fbNotify.show === 'function') window.fbNotify.show(opts || {});
            },
        };
    }

    // ── ctx ──────────────────────────────────────────────────────────────────
    // What a pane's mount() actually receives. Every subscription it hands out
    // is tracked, so unmount() can drop them all — a pane physically cannot
    // leak a listener across a dock/undock cycle, which is the failure mode
    // that would otherwise show up as duplicate handlers after three song
    // switches.

    function createCtx(opts) {
        const paneId = opts.paneId;
        const transport = opts.transport;
        const state = opts.state;
        const disposers = [];
        let disposed = false;

        function track(unsub) {
            if (typeof unsub !== 'function') return () => {};
            // Late subscriptions (a pane calling ctx.on() from a setTimeout that
            // outlived unmount) are torn down immediately rather than silently
            // registered against a dead pane.
            if (disposed) { try { unsub(); } catch (e) { /* already gone */ } return () => {}; }
            disposers.push(unsub);
            return () => {
                const i = disposers.indexOf(unsub);
                if (i >= 0) disposers.splice(i, 1);
                try { unsub(); } catch (e) { /* already gone */ }
            };
        }

        const ctx = {
            paneId: paneId,
            host: opts.host,                 // 'dock' | 'shared' | 'pane:<id>'
            isRemote: transport.kind !== 'local',

            state: {
                get: (path) => state.get(path),
                set: (path, value) => state.set(path, value),
                all: () => state.all(),
                subscribe: (fn) => track(state.subscribe(fn)),
            },

            call: (domain, command, args) => transport.call(domain, command, args),
            on: (name, fn) => track(transport.on(name, fn)),
            subscribe: (stream, fn) => track(transport.subscribe(stream, fn)),
            playhead: () => transport.playhead(),
            song: () => transport.song(),
            toast: (o) => transport.toast(o),

            // Ask the host to put this pane away. The pane does not know or care
            // whether that means closing a dock card or an OS window.
            close: () => { if (typeof opts.onClose === 'function') opts.onClose(); },
        };

        ctx._dispose = function () {
            if (disposed) return;
            disposed = true;
            // Copy-then-clear: a disposer that removes itself from the list
            // (the closure returned by track) would otherwise skip its neighbour.
            const list = disposers.slice();
            disposers.length = 0;
            list.forEach((fn) => { try { fn(); } catch (e) { console.error('[panes] disposer threw', e); } });
        };

        return ctx;
    }

    window.__fbPaneBridge = {
        PROTOCOL_VERSION,
        CHANNEL_NAME,
        DEFAULT_EVENTS,
        CALL_TIMEOUT_MS,
        createStateStore,
        createLocalTransport,
        createCtx,
    };
})();
