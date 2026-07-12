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
    const RPC_TIMEOUT_MS = 10000;   // cross-realm deadline; generous, but never infinite

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

    // ── Envelopes ────────────────────────────────────────────────────────────
    //
    //   { v, type, paneId, hostId, seq, payload }
    //
    // type:  hello     pane→main   the pane realm booted; main replies `snapshot`
    //        snapshot  main→pane   spec + state + current song. Resync-on-open, always.
    //        state     both        { path, value }. Main is authoritative: a pane's
    //                              write is a request; main applies it and echoes to
    //                              every realm, so a losing write self-corrects.
    //        rpc       pane→main   { seq, domain, command, payload }
    //        rpc:reply main→pane   { seq, ok, result | error }
    //        event     main→pane   a mirrored feedBack bus event { name, detail }
    //        stream    main→pane   coalesced numerics (playhead, meters)
    //        sub/unsub pane→main   drives the main-realm sampler's refcount
    //        bye       both        clean teardown (main-closed / pane-closed)

    function envelope(type, paneId, hostId, payload) {
        return { v: PROTOCOL_VERSION, type: type, paneId: paneId, hostId: hostId, payload: payload };
    }

    function openChannel() {
        if (typeof BroadcastChannel !== 'function') return null;
        return new BroadcastChannel(CHANNEL_NAME);
    }

    // ── Remote transport (pane realm) ────────────────────────────────────────

    const MAX_EXTRAP_S = 2.0;   // never extrapolate the clock further than this

    function createRemoteTransport(paneId, hostId, channel) {
        const listeners = new Map();     // event name -> Set<fn>
        const streamSubs = new Map();    // stream name -> Set<fn>
        const pending = new Map();       // rpc seq -> { resolve, reject, timer }
        let rpcSeq = 0;
        let song = null;

        // The follower clock. The main window broadcasts the playhead every frame
        // — but Chromium throttles a BACKGROUNDED window's rAF to ~1 Hz, and the
        // main window is exactly what's in the background while the user looks at
        // this pane. So we extrapolate between messages instead of rendering 1 Hz
        // stutter: anchor + observedRate * elapsed.
        //
        // observedRate is measured from the broadcasts themselves (Δt / Δwall), so
        // it tracks the speed slider without being told about it. Capped at
        // MAX_EXTRAP_S so a dead main window decays into a frozen clock rather
        // than a clock that confidently runs away.
        let anchorT = 0, anchorWall = 0, observedRate = 1, playing = false, duration = 0;

        function _onPlayhead(p) {
            const now = performance.now();
            if (anchorWall && p.playing && playing) {
                const dt = p.t - anchorT;
                const dw = (now - anchorWall) / 1000;
                // Ignore seeks and pauses when learning the rate: a jump is not a
                // tempo. Only smooth, forward-moving deltas teach us anything.
                if (dw > 0.05 && dt > 0 && dt < dw * 4) {
                    const r = dt / dw;
                    observedRate = observedRate * 0.8 + r * 0.2;   // light smoothing
                }
            }
            if (!p.playing) observedRate = 1;   // a paused clock has no rate to learn
            anchorT = p.t;
            anchorWall = now;
            playing = p.playing;
            duration = p.duration;
        }

        function playhead() {
            if (!anchorWall) return anchorT;
            if (!playing) return anchorT;
            const elapsed = Math.min(MAX_EXTRAP_S, (performance.now() - anchorWall) / 1000);
            return anchorT + observedRate * elapsed;
        }

        function handle(msg) {
            const p = msg.payload || {};
            switch (msg.type) {
                case 'event': {
                    const set_ = listeners.get(p.name);
                    // Shaped like a CustomEvent so a pane's handler is identical in
                    // both realms — `e.detail`, not `e`.
                    if (set_) set_.forEach((fn) => { try { fn({ detail: p.detail }); } catch (e) { console.error('[pane] event handler threw', e); } });
                    if (p.name === 'song:loaded') song = p.detail || null;
                    break;
                }
                case 'stream': {
                    if (p.playhead) _onPlayhead(p.playhead);
                    for (const name in p) {
                        const set_ = streamSubs.get(name);
                        if (set_) set_.forEach((fn) => { try { fn(p[name]); } catch (e) { console.error('[pane] stream handler threw', e); } });
                    }
                    break;
                }
                case 'rpc:reply': {
                    const call = pending.get(p.seq);
                    if (!call) return;   // already timed out
                    pending.delete(p.seq);
                    clearTimeout(call.timer);
                    if (p.ok) call.resolve(p.result);
                    else call.reject(new Error(p.error || 'pane rpc failed'));
                    break;
                }
            }
        }

        return {
            kind: 'remote',
            handle: handle,
            setSong: (s) => { song = s; },

            call(domain, command, payload) {
                if (!channel) return Promise.reject(new Error('pane ctx.call: no channel'));
                const seq = ++rpcSeq;
                return new Promise((resolve, reject) => {
                    // Every call gets a deadline. Without one, a main window that
                    // died mid-call leaves the pane's promise pending forever and
                    // its UI stuck on "Pending".
                    const timer = setTimeout(() => {
                        pending.delete(seq);
                        reject(new Error('PaneRpcTimeout: ' + domain + '/' + command));
                    }, RPC_TIMEOUT_MS);
                    pending.set(seq, { resolve, reject, timer });
                    channel.postMessage(envelope('rpc', paneId, hostId, { seq, domain, command, payload: payload || {} }));
                });
            },

            on(name, fn) {
                let set_ = listeners.get(name);
                if (!set_) { set_ = new Set(); listeners.set(name, set_); }
                set_.add(fn);
                return () => set_.delete(fn);
            },

            subscribe(stream, fn) {
                let set_ = streamSubs.get(stream);
                if (!set_) {
                    set_ = new Set();
                    streamSubs.set(stream, set_);
                    if (channel) channel.postMessage(envelope('sub', paneId, hostId, { stream }));
                }
                set_.add(fn);
                return () => {
                    set_.delete(fn);
                    if (!set_.size && channel) channel.postMessage(envelope('unsub', paneId, hostId, { stream }));
                };
            },

            playhead: playhead,
            song: () => song,

            // No toast stack in a pane window, and routing it back to the main
            // window would pop the message up somewhere the user isn't looking.
            toast(opts) { console.info('[pane]', (opts && opts.title) || '', (opts && opts.message) || ''); },
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
        RPC_TIMEOUT_MS,
        MAX_EXTRAP_S,
        envelope,
        openChannel,
        createStateStore,
        createLocalTransport,
        createRemoteTransport,
        createCtx,
    };
})();
