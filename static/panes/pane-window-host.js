/*
 * fee[dB]ack — the pop-out window host (browser path).
 *
 * Opens a real OS window per pane and hands it off to pane-hub.js, which serves
 * it over BroadcastChannel. Registers as the `window` host at priority 10, so it
 * outranks the dock and `panes.detach()` prefers it.
 *
 * This is the BROWSER implementation: a plain same-origin `window.open()`, which
 * is what the splitscreen follower has done for years. Electron already permits
 * it — main.ts's setWindowOpenHandler returns `action: 'allow'` for same-origin
 * URLs, and that is load-bearing: `deny` would push the URL to the system
 * browser, a different Chromium instance, where BroadcastChannel cannot reach it
 * and the pane would silently never sync.
 *
 * The desktop app will register its own host at a higher priority (a real
 * BrowserWindow, with a system tray, always-on-top, and remembered bounds).
 * Nothing else changes when it does — that is the point of the host registry.
 */
(function () {
    'use strict';

    const panes = window.feedBack && window.feedBack.panes;
    if (!panes || typeof panes.registerHost !== 'function') {
        console.error('[panes] pane-manager.js must load before pane-window-host.js');
        return;
    }

    const wins = new Map();   // paneId -> Window
    let reaper = null;

    // A pane window the user closed with the OS X button never gets to say `bye`
    // reliably (a crashed renderer certainly doesn't). Poll `closed` and reap —
    // otherwise the pane stays "open" forever, its chip stays stubbed out, and
    // the user has no way back to their dialog. Same trick splitscreen uses.
    function _startReaper() {
        if (reaper != null) return;
        reaper = setInterval(() => {
            wins.forEach((w, id) => {
                if (w.closed) panes.close(id);   // → unmount() below clears the entry
            });
            if (!wins.size) { clearInterval(reaper); reaper = null; }
        }, 500);
    }

    function mount(spec) {
        const url = new URL(window.location.origin + '/pane');
        url.searchParams.set('pane', spec.id);
        // The pane realm loads its mount() from this URL. Everything else it
        // needs (title, state, the song) arrives in the snapshot — URL params
        // are open-time only and must never be a state channel.
        url.searchParams.set('script', spec.script);

        const w = window.open(url.toString(), 'fbpane-' + spec.id,
            'popup,width=' + spec.width + ',height=' + spec.height);

        if (!w) {
            // Popup blocked. Bail BEFORE the manager records anything, so the
            // caller's dialog stays exactly where it was — and say so out loud
            // rather than appearing to do nothing.
            if (window.fbNotify) {
                window.fbNotify.show({
                    title: 'Pop-out blocked',
                    message: 'Allow pop-ups for this site to detach ' + spec.title + '.',
                    icon: '⚠️', accent: '#f59e0b',
                });
            }
            return null;
        }

        wins.set(spec.id, w);
        _startReaper();
        return w;
    }

    function unmount(id) {
        const w = wins.get(id);
        wins.delete(id);
        // Closing an already-closed window is a no-op, and closing one we opened
        // is always permitted (same-origin, script-opened).
        if (w && !w.closed) { try { w.close(); } catch (e) { /* already gone */ } }
    }

    function focus(id) {
        const w = wins.get(id);
        if (w && !w.closed) { try { w.focus(); } catch (e) { /* OS may refuse */ } }
    }

    panes.registerHost({
        id: 'window',
        priority: 10,
        remote: true,
        // A browser blocks window.open() outside a user gesture, so a pane
        // remembered here cannot be restored on page load — it would only ever
        // produce a "pop-up blocked" toast. The manager brings it back in the dock
        // and the chip pops it out again on the user's next click. The desktop
        // host overrides this: it opens real BrowserWindows and needs no gesture.
        autoRestore: false,
        // No BroadcastChannel means no way to feed the pane once it's open. Better
        // to keep it docked than to open a window that renders forever-stale data.
        available: () => typeof BroadcastChannel === 'function',
        // A pane with no `script` exists only as a closure in this realm. There is
        // no honest way to move a closure across a window boundary, so decline it
        // and let the router fall back to the dock.
        canHost: (spec) => !!spec.script,
        mount, unmount, focus,
    });

    // The pane windows are ours; they must not outlive us. A pane window whose
    // main window is gone can never be fed again — leaving it on screen showing a
    // frozen playhead is worse than closing it.
    window.addEventListener('beforeunload', () => {
        wins.forEach((w) => { if (!w.closed) { try { w.close(); } catch (e) { /* ignore */ } } });
    });
})();
