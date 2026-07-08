    // ---------------------------------------------------------------------
    // Player Controls - Target Labels Toggle
    // ---------------------------------------------------------------------

    const LABELS_BTN_ID = 'multipad-h3d-labels-toggle';

    /**
     * Resolve the v3 plugin-control slot (the "Plugins" rail popover), or
     * null in v2 / when the host API isn't available. See
     * docs/plugin-v3-ui.md's canonical injection pattern - v2's
     * `#player-controls` bar is a fixed always-visible container, but v3's
     * is a minimal auto-hiding transport with no reliable insertion anchor,
     * so any player-controls injection must detect v3 and mount into this
     * slot instead.
     *
     * @returns {Element|null}
     */
    function playerSlot() {
        if (typeof window === 'undefined' || !(window.feedBack && window.feedBack.uiVersion === 'v3'
            && window.feedBack.ui && typeof window.feedBack.ui.playerControlSlot === 'function')) {
            return null;
        }
        try {
            return window.feedBack.ui.playerControlSlot();
        } catch (_e) {
            // Host slot API failure - fall back to the legacy v2 bar rather
            // than letting the exception propagate out of the caller.
            return null;
        }
    }

    /**
     * Sync the injected toggle button's pressed/unpressed visual state with
     * the current showLabels setting. Safe to call whether or not the
     * button has been injected yet.
     *
     * @returns {void}
     */
    function updateLabelsButton() {
        if (typeof document === 'undefined') return;
        const btn = document.getElementById(LABELS_BTN_ID);
        if (!btn) return;
        const on = !!readSettings().showLabels;
        btn.className = on
            ? 'px-3 py-1.5 bg-accent/20 hover:bg-accent/30 border border-accent rounded-lg text-xs text-accent transition'
            : 'px-3 py-1.5 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-400 transition';
        btn.setAttribute('aria-pressed', String(on));
    }

    /**
     * Inject the "Labels" toggle button into the player controls, once per
     * screen (guarded by element id - re-entering the player screen is a
     * no-op if the button is already there). Mirrors the pattern used
     * elsewhere in this app for a player-injected control (see
     * docs/plugin-v3-ui.md): v3 mounts into the stable plugin-control slot,
     * v2 falls back to `#player-controls`, inserting before the legacy
     * separator/close-button anchor only in v2 (that anchor doesn't exist
     * in the v3 transport).
     *
     * This single button controls visibility for every multipad target
     * label - pads, pedal surfaces, and external triggers alike (see
     * buildSurfaceGrid/buildSurfaceLabel in 04-renderer.js) - since they
     * all read the same `showLabels` setting this button flips.
     *
     * @returns {void}
     */
    function injectLabelsToggleButton() {
        if (typeof document === 'undefined') return;
        const slot = playerSlot();
        const controls = slot || document.getElementById('player-controls');
        if (!controls || document.getElementById(LABELS_BTN_ID)) return;
        const btn = document.createElement('button');
        btn.id = LABELS_BTN_ID;
        btn.type = 'button';
        btn.textContent = 'Labels';
        btn.title = 'Toggle multipad target labels';
        btn.setAttribute('aria-label', 'Toggle multipad target labels');
        btn.onclick = () => {
            writeSetting('showLabels', !readSettings().showLabels);
            updateLabelsButton();
        };
        const anchor = slot ? null : controls.querySelector('span.text-gray-700, button:last-child');
        if (anchor) controls.insertBefore(btn, anchor);
        else controls.appendChild(btn);
        updateLabelsButton();
    }

    if (typeof window !== 'undefined' && window.feedBack && typeof window.feedBack.on === 'function') {
        window.feedBack.on('screen:changed', (ev) => {
            if (ev && ev.detail && ev.detail.id === 'player') injectLabelsToggleButton();
        });
        if (typeof document !== 'undefined' && document.querySelector
            && (document.querySelector('.screen.active') || {}).id === 'player') {
            injectLabelsToggleButton();
        }
    }

    // Exposed for tests, which drive injection directly against a stubbed
    // document/window.feedBack rather than the real screen:changed event.
    if (createFactory.__test) {
        createFactory.__test.injectLabelsToggleButton = injectLabelsToggleButton;
        createFactory.__test.updateLabelsButton = updateLabelsButton;
        createFactory.__test.LABELS_BTN_ID = LABELS_BTN_ID;
    }
