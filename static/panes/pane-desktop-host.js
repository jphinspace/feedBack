/*
 * fee[dB]ack — the desktop pane host.
 *
 * When running inside the desktop app, a popped-out pane gets a real
 * BrowserWindow instead of a browser pop-up: it remembers where you put it, it
 * can float above everything, it minimizes to the system tray, and the tray
 * lists every pane you have.
 *
 * Registers as the `desktop` host at priority 20 — above `window` (10, the
 * browser pop-up) and `dock` (0) — so `panes.detach()` picks it whenever the
 * desktop bridge is present. In a plain browser this file registers nothing and
 * the browser pop-up host takes over. Nothing else in the pane system changes;
 * that is what the host registry is for.
 *
 * The renderer stays the authority on what a pane IS. The main process only owns
 * the window. So this file pushes the pane registry up to the tray, and answers
 * the tray when it asks for a pane to be toggled.
 */
(function () {
    'use strict';

    const panes = window.feedBack && window.feedBack.panes;
    const bus = window.feedBack;
    // `feedBackDesktop.panes` is absent in a browser, and also in an OLDER
    // desktop build that predates this feature — in both cases we simply don't
    // register, and the browser pop-out host handles detach as before.
    const desktop = window.feedBackDesktop && window.feedBackDesktop.panes;
    if (!panes || !bus || !desktop) return;

    const open = new Set();

    function mount(spec) {
        const url = new URL(window.location.origin + '/pane');
        url.searchParams.set('pane', spec.id);
        url.searchParams.set('script', spec.script);

        open.add(spec.id);
        // Fire-and-forget: the pane's contents arrive over BroadcastChannel from
        // pane-hub.js, not through this call. All the main process does is put a
        // window on screen pointing at our own origin.
        desktop.open({
            paneId: spec.id,
            url: url.toString(),
            title: spec.title,
            width: spec.width,
            height: spec.height,
        }).then((ok) => {
            if (ok) return;
            console.error('[panes] desktop refused to open a window for', spec.id);
            open.delete(spec.id);
            panes.close(spec.id);
        }).catch((err) => {
            console.error('[panes] desktop pane open failed', spec.id, err);
            open.delete(spec.id);
            panes.close(spec.id);
        });

        return { paneId: spec.id };   // an opaque handle; the manager only checks it's truthy
    }

    function unmount(id) {
        open.delete(id);
        desktop.close(id).catch(() => { /* window already gone */ });
    }

    panes.registerHost({
        id: 'desktop',
        priority: 20,
        remote: true,
        // Unlike a browser pop-up, this needs no user gesture — so a pane the user
        // left popped out comes back popped out, where they left it, on next launch.
        autoRestore: true,
        available: () => typeof BroadcastChannel === 'function',
        // A pane with no `script` is only a closure in this realm and cannot
        // honestly cross a window boundary; the router falls back to the dock.
        canHost: (spec) => !!spec.script,
        mount,
        unmount,
        focus: (id) => { desktop.focus(id).catch(() => { /* window already gone */ }); },
    });

    // The user closed the pane window (or it crashed). Close the pane, so the
    // dialog its pop-out chip hid comes back — otherwise the user's own UI is
    // hidden with no way to reach it.
    desktop.onClosed((paneId) => {
        if (!open.has(paneId)) return;
        open.delete(paneId);
        panes.close(paneId);
    });

    // The tray asked to toggle a pane it has no window for. Only this realm knows
    // what opening one means.
    desktop.onToggle((paneId) => {
        if (panes.isOpen(paneId)) panes.close(paneId);
        else panes.detach(paneId);
    });

    // Keep the tray's menu in step with the registry. Cheap and rare — panes are
    // registered at load and toggled by hand, never on a playback path.
    function sync() {
        desktop.sync(panes.list().map((p) => ({ id: p.id, title: p.title, icon: p.icon, open: p.open })));
    }
    bus.on('panes:registered', sync);
    bus.on('panes:unregistered', sync);
    bus.on('panes:opened', sync);
    bus.on('panes:closed', sync);
    sync();
})();
