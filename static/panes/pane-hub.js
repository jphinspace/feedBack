/*
 * fee[dB]ack — pane hub (main realm).
 *
 * The server side of the pane channel. Every popped-out pane talks to exactly
 * this file, and this file is the only thing in the app that knows a pane might
 * be in another window.
 *
 * It answers `hello` with a snapshot, forwards allowlisted bus events, runs the
 * pane's capability calls on its behalf, applies its state writes (the main realm
 * is the sole authority), and samples the streams it asks for — pushing plain
 * numbers, because the AnalyserNode behind `meters` can never cross a window
 * boundary.
 *
 * Nothing here is reachable from a pane. A pane sees `ctx`, and `ctx` is all.
 */
(function () {
    'use strict';

    const B = window.__fbPaneBridge;
    const panes = window.feedBack && window.feedBack.panes;
    const bus = window.feedBack;
    if (!B || !panes || !bus) { console.error('[panes] pane-hub.js loaded too early'); return; }

    const channel = B.openChannel();
    if (!channel) return;   // no BroadcastChannel → the window host declines to open anything anyway

    // paneId -> { streams: Map<name, unsub>, pending: Object|null, rafId }
    const conns = new Map();
    // Bus events we have hooked, so N panes share one listener per event.
    const busHooks = new Map();   // event name -> { fn, refs }

    function send(type, paneId, payload) {
        channel.postMessage(B.envelope(type, paneId, 'main', payload));
    }

    // ── Bus mirroring ────────────────────────────────────────────────────────

    function _hookEvent(name) {
        let hook = busHooks.get(name);
        if (hook) { hook.refs++; return; }
        const fn = (e) => {
            // Only forward to panes that actually want this event, and only
            // structured-cloneable detail — a CustomEvent carrying a DOM node
            // (highway:canvas-replaced does) would throw on postMessage and kill
            // the channel for everyone.
            let detail = null;
            try { detail = JSON.parse(JSON.stringify(e.detail === undefined ? null : e.detail)); }
            catch (err) { detail = null; }   // not serialisable: the event still fires, sans payload
            conns.forEach((_, paneId) => {
                const spec = panes.get(paneId);
                if (spec && spec.events.indexOf(name) >= 0) send('event', paneId, { name, detail });
            });
        };
        bus.on(name, fn);
        busHooks.set(name, { fn, refs: 1 });
    }

    function _unhookEvent(name) {
        const hook = busHooks.get(name);
        if (!hook) return;
        if (--hook.refs > 0) return;
        bus.off(name, hook.fn);
        busHooks.delete(name);
    }

    // ── Streams ──────────────────────────────────────────────────────────────
    //
    // The sampler (pane-streams.js) fires per frame. We do NOT post per stream
    // per frame — we coalesce every stream a pane wants into ONE message and post
    // it on the next frame, overwriting anything not yet flushed.
    //
    // Overwriting rather than queueing is the whole trick: Chromium throttles a
    // backgrounded window (which the MAIN window is, while the user looks at the
    // pane), so a queue would grow a backlog of stale frames and then dump them.
    // The pane extrapolates its own clock between whatever it does receive.

    function _flush(paneId) {
        const conn = conns.get(paneId);
        if (!conn) return;
        conn.rafId = null;
        if (!conn.pending) return;
        const payload = conn.pending;
        conn.pending = null;
        send('stream', paneId, payload);
    }

    function _onStreamValue(paneId, name, value) {
        const conn = conns.get(paneId);
        if (!conn) return;
        if (!conn.pending) conn.pending = {};
        conn.pending[name] = value;   // last value for this frame wins
        if (conn.rafId == null) conn.rafId = requestAnimationFrame(() => _flush(paneId));
    }

    function _subscribe(paneId, name) {
        const conn = conns.get(paneId);
        if (!conn || conn.streams.has(name)) return;
        conn.streams.set(name, window.__fbPaneStreams.subscribe(name, (v) => _onStreamValue(paneId, name, v)));
    }

    function _unsubscribe(paneId, name) {
        const conn = conns.get(paneId);
        if (!conn) return;
        const unsub = conn.streams.get(name);
        if (unsub) { unsub(); conn.streams.delete(name); }
    }

    // ── Connections ──────────────────────────────────────────────────────────

    function _connect(paneId) {
        if (conns.has(paneId)) _disconnect(paneId);   // a reloaded pane window says hello again
        conns.set(paneId, { streams: new Map(), pending: null, rafId: null });
        const spec = panes.get(paneId);
        if (spec) spec.events.forEach(_hookEvent);
    }

    function _disconnect(paneId) {
        const conn = conns.get(paneId);
        if (!conn) return;
        conn.streams.forEach((unsub) => unsub());
        if (conn.rafId != null) cancelAnimationFrame(conn.rafId);
        conns.delete(paneId);
        const spec = panes.get(paneId);
        if (spec) spec.events.forEach(_unhookEvent);
    }

    function _snapshot(paneId) {
        const entry = panes._entry(paneId);
        const spec = panes.get(paneId);
        if (!entry || !spec) return null;
        return {
            spec: { id: spec.id, title: spec.title, icon: spec.icon, script: spec.script },
            state: entry.state.all(),
            song: (window.feedBack && window.feedBack.currentSong) || null,
        };
    }

    // ── Channel ──────────────────────────────────────────────────────────────

    channel.addEventListener('message', (e) => {
        const msg = e.data;
        if (!msg || msg.v !== B.PROTOCOL_VERSION || msg.hostId === 'main') return;
        const paneId = msg.paneId;
        const p = msg.payload || {};

        switch (msg.type) {
            case 'hello': {
                const snap = _snapshot(paneId);
                if (!snap) {
                    // The pane window outlived its registration (main window
                    // reloaded while a pane window stayed open). Tell it so it can
                    // close itself rather than sit there frozen.
                    send('bye', paneId, { reason: 'unknown-pane' });
                    return;
                }
                _connect(paneId);
                send('snapshot', paneId, snap);
                break;
            }

            case 'rpc': {
                const caps = window.feedBack.capabilities;
                const reply = (ok, result, error) => send('rpc:reply', paneId, { seq: p.seq, ok, result, error });
                if (!caps || typeof caps.command !== 'function') { reply(false, null, 'capability bus unavailable'); return; }
                caps.command(p.domain, p.command, {
                    requester: 'pane.' + paneId,
                    origin: 'pane',
                    payload: p.payload || {},
                    timeoutMs: B.CALL_TIMEOUT_MS,
                }).then((result) => {
                    // The result crosses a window boundary, so it must survive
                    // structured clone. A capability that answers with a live
                    // object (a node, a function) would otherwise throw here and
                    // take the channel down with it.
                    let safe = null;
                    try { safe = JSON.parse(JSON.stringify(result === undefined ? null : result)); }
                    catch (err) { reply(false, null, 'result is not serialisable'); return; }
                    reply(true, safe, null);
                }).catch((err) => reply(false, null, String((err && err.message) || err)));
                break;
            }

            case 'state': {
                const entry = panes._entry(paneId);
                if (!entry) return;
                // The main realm is authoritative: apply, then echo to everyone.
                // A pane's own optimistic paint is corrected by the echo, so two
                // panes racing on one key converge instead of diverging.
                if (entry.state.set(p.path, p.value)) send('state', paneId, { path: p.path, value: p.value });
                break;
            }

            case 'sub':   _subscribe(paneId, p.stream); break;
            case 'unsub': _unsubscribe(paneId, p.stream); break;

            case 'bye': {
                _disconnect(paneId);
                // The pane window is going away for good (the user closed it).
                // Closing the pane un-hides whatever dialog the chip hid, which is
                // the only outcome that leaves the user able to find their UI again.
                if (panes.isOpen(paneId)) panes.close(paneId);
                break;
            }
        }
    });

    // The main window is the only thing feeding the panes. When it goes, they
    // cannot be fed — tell them, so they show a dead state instead of a
    // convincing but frozen one. (The window host also closes them outright; this
    // covers a host that can't, such as the desktop's own windows.)
    window.addEventListener('beforeunload', () => {
        conns.forEach((_, paneId) => send('bye', paneId, { reason: 'main-closed' }));
    });

    // A pane that is closed from THIS side (the stub, the launcher, the tray)
    // must be told, or its window sits there orphaned.
    bus.on('panes:closed', (e) => {
        const id = e.detail && e.detail.id;
        if (conns.has(id)) { send('bye', id, { reason: 'closed-by-host' }); _disconnect(id); }
    });
})();
