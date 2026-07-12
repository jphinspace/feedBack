/*
 * fee[dB]ack — pane manager.
 *
 * The registry and host router behind `window.feedBack.panes`. Main realm only.
 *
 * A "pane" is a piece of live UI — a mixer, a camera rig, a readout — authored
 * once as `mount(root, ctx)` and mountable into any *host*: the in-window dock
 * today, a pop-out OS window later. The manager owns which pane is open and
 * where; hosts own the chrome; the pane owns nothing but its own DOM.
 *
 * The problem this exists to solve: the player's rail popovers are exclusive
 * (opening one closes the last), so you cannot watch the mixer while riding the
 * camera — and both vanish the moment you want to look at the highway. Panes
 * are non-exclusive by construction and survive song switches, because nothing
 * about them is tied to the per-song teardown.
 *
 * Hosts register themselves; the manager never imports one. That is what lets
 * the pop-out window host drop in later without this file changing.
 */
(function () {
    'use strict';

    const B = window.__fbPaneBridge;
    if (!B) { console.error('[panes] pane-bridge.js must load before pane-manager.js'); return; }

    const HOSTS_KEY = 'fbPaneHosts';       // { paneId: hostId } — panes open at last unload
    const STATE_KEY = (id) => 'fbPane:' + id;

    // id -> normalized spec
    const specs = new Map();
    // id -> { spec, hostId, root, ctx, state }
    const open = new Map();
    // hostId -> host provider
    const hosts = new Map();

    // ── Persistence ──────────────────────────────────────────────────────────
    // localStorage is shared with any pop-out realm (same origin), so a
    // concurrent writer there would silently clobber us. The rule, enforced by
    // this file being main-realm-only: THE MAIN REALM IS THE ONLY WRITER. A pane
    // asks; the manager writes.

    function _readJSON(key, fallback) {
        try {
            const raw = localStorage.getItem(key);
            return raw ? JSON.parse(raw) : fallback;
        } catch (e) { return fallback; }   // private mode / corrupt value
    }
    function _writeJSON(key, value) {
        try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* quota / private mode: non-fatal */ }
    }

    function _rememberHost(id, hostId) {
        const map = _readJSON(HOSTS_KEY, {});
        if (hostId) map[id] = hostId; else delete map[id];
        _writeJSON(HOSTS_KEY, map);
    }

    // Pane state is saved on a trailing debounce — a fader drag writes on every
    // input event, and localStorage is synchronous.
    const _saveTimers = new Map();
    function _scheduleSave(id, state) {
        clearTimeout(_saveTimers.get(id));
        _saveTimers.set(id, setTimeout(() => {
            _saveTimers.delete(id);
            _writeJSON(STATE_KEY(id), state.all());
        }, 250));
    }

    // ── Spec ─────────────────────────────────────────────────────────────────

    function _normalize(spec) {
        if (!spec || typeof spec !== 'object') throw new TypeError('panes.register: spec must be an object');
        if (!spec.id || typeof spec.id !== 'string') throw new TypeError('panes.register: spec.id is required');
        if (typeof spec.mount !== 'function') throw new TypeError('panes.register(' + spec.id + '): spec.mount is required');
        return {
            id: spec.id,
            title: spec.title || spec.id,
            icon: spec.icon || '▣',
            mount: spec.mount,
            unmount: typeof spec.unmount === 'function' ? spec.unmount : null,
            // Bus events mirrored into a pop-out realm for this pane. Docked, ctx.on()
            // reaches the real bus regardless — this list only matters once the
            // pane is in another realm, and it is declared here so it is the same
            // list in both.
            events: Array.isArray(spec.events) ? B.DEFAULT_EVENTS.concat(spec.events) : B.DEFAULT_EVENTS,
            persist: spec.persist !== false,          // default on; opt out with `persist: false`
            initialState: spec.initialState || {},
            defaultHost: spec.defaultHost || 'window',
            // URL of the module the pane REALM loads to obtain this pane's
            // mount(). A pane with no script can only ever be docked — it exists
            // solely as a closure in this realm, and there is no honest way to
            // move a closure across a window boundary. The window host declines
            // such panes and the router falls back to the dock.
            script: spec.script || null,
            mirrorGlobal: spec.mirrorGlobal || null,  // honoured by pane-mirror.js
            width: spec.width || 380,
            height: spec.height || 560,
        };
    }

    // ── Host routing ─────────────────────────────────────────────────────────
    // A host provider is `{ id, priority, available(), mount(spec) -> Element,
    // unmount(id), focus(id) }`. Higher priority wins when a pane asks for a
    // host it can't have.

    function _resolveHost(preferred, spec) {
        const wanted = hosts.get(preferred);
        if (wanted && wanted.available() && wanted.canHost(spec)) return wanted;
        // Fall back to the best host that IS available and WILL take this pane,
        // preferring the highest priority. The dock registers at priority 0 and
        // accepts everything, so it is always the floor — a pane can never fail
        // to open just because the window host is unavailable or declines it.
        let best = null;
        hosts.forEach((h) => {
            if (!h.available() || !h.canHost(spec)) return;
            if (!best || h.priority > best.priority) best = h;
        });
        return best;
    }

    function _emit(name, detail) {
        const bus = window.feedBack;
        if (bus && typeof bus.emit === 'function') bus.emit(name, detail);
    }

    // ── Public API ───────────────────────────────────────────────────────────

    function register(spec) {
        const s = _normalize(spec);
        if (specs.has(s.id)) {
            // First registration wins, matching libraryCardActions.register. A
            // silent overwrite would let a re-injected plugin script swap the
            // mount function out from under an already-open pane.
            console.warn('[panes] pane already registered, ignoring:', s.id);
            return () => {};
        }
        specs.set(s.id, s);
        _emit('panes:registered', { id: s.id, title: s.title });

        // Reopen where the user left it. Deferred a tick so a plugin can call
        // register() and attachChip() back-to-back — the chip must exist before
        // the pane opens or it has nothing to hide.
        //
        // A host may refuse to be auto-restored: a browser blocks window.open()
        // without a user gesture, so restoring a popped-out pane on page load
        // would only ever produce a "pop-up blocked" toast. Such a pane comes back
        // in the dock, and the chip pops it out again on the user's next click.
        // (The desktop host has no such restriction and restores in place.)
        let remembered = _readJSON(HOSTS_KEY, {})[s.id];
        if (remembered) {
            const h = hosts.get(remembered);
            if (h && h.autoRestore === false) remembered = 'dock';
            setTimeout(() => { if (specs.has(s.id) && !open.has(s.id)) openPane(s.id, { host: remembered, remember: false }); }, 0);
        }

        return () => unregister(s.id);
    }

    function unregister(id) {
        if (open.has(id)) closePane(id, { remember: false });
        specs.delete(id);
        _emit('panes:unregistered', { id: id });
    }

    function openPane(id, opts) {
        opts = opts || {};
        const spec = specs.get(id);
        if (!spec) { console.warn('[panes] open: no such pane:', id); return false; }
        if (open.has(id)) { focusPane(id); return true; }

        const host = _resolveHost(opts.host || spec.defaultHost, spec);
        if (!host) { console.error('[panes] open: no host available for', id); return false; }

        const state = B.createStateStore(spec.persist ? _readJSON(STATE_KEY(id), spec.initialState) : spec.initialState);
        if (spec.persist) state.subscribe(() => _scheduleSave(id, state));

        // A REMOTE host (a pop-out window) runs the pane's mount() in its own
        // realm — this realm never sees the pane's DOM and must not call mount()
        // itself. All we own here is the authoritative state store; pane-hub.js
        // serves the other realm from it.
        if (host.remote) {
            let handle;
            try {
                handle = host.mount(spec);
            } catch (e) {
                console.error('[panes] host', host.id, 'failed to open a window for', id, e);
                return false;
            }
            if (!handle) return false;   // host already explained itself (popup blocked, etc.)
            open.set(id, { spec, hostId: host.id, state, remote: true, handle });
            if (opts.remember !== false) _rememberHost(id, host.id);
            _emit('panes:opened', { id: id, host: host.id });
            return true;
        }

        let root;
        try {
            root = host.mount(spec);
        } catch (e) {
            console.error('[panes] host', host.id, 'failed to mount', id, e);
            return false;
        }

        const ctx = B.createCtx({
            paneId: id,
            host: host.id,
            transport: B.createLocalTransport(id),
            state: state,
            onClose: () => closePane(id),
        });

        const entry = { spec, hostId: host.id, root, ctx, state };
        open.set(id, entry);

        try {
            spec.mount(root, ctx);
        } catch (e) {
            // A pane that throws in mount() must not leave a half-open shell
            // behind — tear the whole thing back down and tell the user, rather
            // than leaving an empty card they can't explain.
            console.error('[panes] pane threw in mount():', id, e);
            closePane(id, { remember: false });
            if (window.fbNotify) window.fbNotify.show({ title: spec.title, message: 'Failed to open.', icon: '⚠️', accent: '#f59e0b' });
            return false;
        }

        if (opts.remember !== false) _rememberHost(id, host.id);
        _emit('panes:opened', { id: id, host: host.id });
        return true;
    }

    function closePane(id, opts) {
        opts = opts || {};
        const entry = open.get(id);
        if (!entry) return false;
        open.delete(id);

        // Order matters for a local pane: the pane tears down its own DOM and
        // listeners first, then ctx drops everything it handed out, then the host
        // removes the shell. Reversing any of these hands the pane a root that has
        // already been detached, or leaks the subscriptions its unmount() assumed
        // it kept. A remote pane's mount/unmount ran in the other realm and
        // teardown goes with the window, so there is nothing to do but close it.
        if (!entry.remote) {
            try { if (entry.spec.unmount) entry.spec.unmount(entry.root, entry.ctx); }
            catch (e) { console.error('[panes] pane threw in unmount():', id, e); }
            try { entry.ctx._dispose(); } catch (e) { console.error('[panes] ctx dispose threw:', id, e); }
        }

        const host = hosts.get(entry.hostId);
        try { if (host) host.unmount(id); } catch (e) { console.error('[panes] host', entry.hostId, 'threw in unmount:', id, e); }

        // Flush any pending debounced state write — closing must not lose the
        // last fader nudge.
        if (entry.spec.persist) {
            clearTimeout(_saveTimers.get(id));
            _saveTimers.delete(id);
            _writeJSON(STATE_KEY(id), entry.state.all());
        }

        if (opts.remember !== false) _rememberHost(id, null);
        _emit('panes:closed', { id: id, host: entry.hostId });
        return true;
    }

    // Move an open pane to a different host without losing its state: the pane's
    // DOM is rebuilt (mount runs again against the new root) but its state store
    // is the persisted one, so a fader sits where the user left it.
    function movePane(id, hostId) {
        const wasOpen = open.has(id);
        if (wasOpen) closePane(id, { remember: false });
        return openPane(id, { host: hostId });
    }

    function focusPane(id) {
        const entry = open.get(id);
        if (!entry) return false;
        const host = hosts.get(entry.hostId);
        if (host && typeof host.focus === 'function') host.focus(id);
        return true;
    }

    // `detach` is what the pop-out chip calls: put this pane wherever a pane
    // most wants to live. Today the dock is usually the only host; once the
    // window host registers, it outranks the dock and the same call opens an OS
    // window instead. The chip never changes.
    function detach(id) {
        const spec = specs.get(id);
        return openPane(id, { host: (spec && spec.defaultHost) || 'window' });
    }

    function dock(id) { return movePane(id, 'dock'); }

    function registerHost(host) {
        if (!host || !host.id) throw new TypeError('panes: host needs an id');
        hosts.set(host.id, {
            id: host.id,
            priority: host.priority || 0,
            // `remote: true` means the pane's mount() runs in ANOTHER JS realm.
            // The manager then owns only the state store, and pane-hub.js serves
            // the pane over the channel.
            remote: !!host.remote,
            // `autoRestore: false` — this host cannot be opened without a user
            // gesture, so a pane remembered here comes back in the dock instead.
            autoRestore: host.autoRestore !== false,
            available: typeof host.available === 'function' ? host.available : () => true,
            canHost: typeof host.canHost === 'function' ? host.canHost : () => true,
            mount: host.mount,
            unmount: host.unmount,
            focus: host.focus,
        });
    }

    const api = {
        version: 1,
        register,
        unregister,
        open: openPane,
        close: closePane,
        move: movePane,
        focus: focusPane,
        detach,
        dock,
        isOpen: (id) => open.has(id),
        hostOf: (id) => { const e = open.get(id); return e ? e.hostId : null; },
        get: (id) => specs.get(id) || null,
        list: () => Array.from(specs.values()).map((s) => ({ id: s.id, title: s.title, icon: s.icon, open: open.has(s.id), host: (open.get(s.id) || {}).hostId || null })),
        // Host registration is host-internal, but it lives on the same object so
        // a future out-of-tree host (a plugin shipping its own window shell) can
        // participate without a private import.
        registerHost,

        // Host-internal. pane-hub.js serves a pop-out realm from the
        // authoritative state store, which only lives here. Not part of the pane
        // API — panes must never reach for this.
        _entry: (id) => open.get(id) || null,
    };

    window.feedBack = window.feedBack || {};
    window.feedBack.panes = Object.assign(window.feedBack.panes || {}, api);
})();
