/*
 * fee[dB]ack — the pop-out chip.
 *
 * One affordance, core-owned, identical everywhere: the small ⇱ button a plugin
 * drops into a dialog it already has.
 *
 *     feedBack.panes.register({ id: 'camera_director', title: 'Camera', mount, unmount });
 *     feedBack.panes.attachChip(myDialogEl, 'camera_director');
 *
 * That is the entire adoption cost. Clicking the chip opens the pane in its host
 * and hides `myDialogEl`; a stub takes its place so the user can find it again;
 * closing the pane un-hides the dialog and restores the chip. The plugin writes
 * no show/hide logic — if it did, every plugin would invent a slightly different
 * one, which is exactly the inconsistency this exists to prevent.
 *
 * Hiding uses `.fb-pane-detached`, NOT the `hidden` class or `[hidden]`, because
 * the dialogs being hidden here already toggle those themselves (the core mixer
 * popover, every rail popover). Two owners of one class is a bug waiting for a
 * bad day; a dedicated class composes cleanly with whatever the dialog does.
 */
(function () {
    'use strict';

    const panes = window.feedBack && window.feedBack.panes;
    if (!panes || typeof panes.register !== 'function') {
        console.error('[panes] pane-manager.js must load before pane-chip.js');
        return;
    }

    // paneId -> { el, chip, stub, spec }
    const attached = new Map();

    function _makeChip(spec) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'fb-pane-chip';
        b.title = 'Pop out';
        b.setAttribute('aria-label', 'Pop out ' + spec.title);
        b.textContent = '⇱';
        b.addEventListener('click', (e) => {
            // Rail popovers close on any document click that lands outside them
            // (player-chrome.js). Without this the popover would close under the
            // chip mid-click, which reads as the button not working.
            e.stopPropagation();
            e.preventDefault();
            panes.detach(spec.id);
        });
        return b;
    }

    function _makeStub(spec) {
        const s = document.createElement('button');
        s.type = 'button';
        s.className = 'fb-pane-stub';
        s.setAttribute('aria-label', 'Bring ' + spec.title + ' back');
        s.title = 'Bring it back';
        const glyph = document.createElement('span');
        glyph.className = 'fb-pane-stub-glyph';
        glyph.textContent = '⇲';
        const label = document.createElement('span');
        label.textContent = spec.title + ' is popped out';
        s.appendChild(glyph);
        s.appendChild(label);
        s.addEventListener('click', (e) => {
            e.stopPropagation();
            e.preventDefault();
            panes.close(spec.id);
        });
        return s;
    }

    function _onOpened(rec) {
        rec.el.classList.add('fb-pane-detached');
        if (!rec.stub.isConnected) rec.el.parentNode.insertBefore(rec.stub, rec.el);
    }

    function _onClosed(rec) {
        rec.el.classList.remove('fb-pane-detached');
        rec.stub.remove();
    }

    /**
     * attachChip(el, paneId, opts)
     *
     * `el`   — the dialog to hide when the pane pops out. The chip is injected
     *          into `el.querySelector('[data-pane-header]')` when present, else
     *          prepended to `el` itself.
     * `opts` — { header: Element } to place the chip somewhere specific.
     *
     * Returns a detach function that removes the chip and stub and restores the
     * dialog — call it if your plugin tears its dialog down.
     */
    function attachChip(el, paneId, opts) {
        opts = opts || {};
        if (!(el instanceof Element)) throw new TypeError('panes.attachChip: el must be an Element');
        const spec = panes.get(paneId);
        if (!spec) { console.warn('[panes] attachChip: register the pane first:', paneId); return () => {}; }
        if (attached.has(paneId)) { console.warn('[panes] attachChip: already attached:', paneId); return () => {}; }

        const chip = _makeChip(spec);
        const stub = _makeStub(spec);
        const host = opts.header || el.querySelector('[data-pane-header]') || el;
        if (host === el) host.insertBefore(chip, host.firstChild);
        else host.appendChild(chip);

        const rec = { el, chip, stub, spec };
        attached.set(paneId, rec);

        // Reconcile immediately: register() reopens a pane the user left open at
        // last unload, and that can land before (or after) attachChip runs.
        if (panes.isOpen(paneId)) _onOpened(rec);

        return () => {
            if (attached.get(paneId) !== rec) return;
            attached.delete(paneId);
            chip.remove();
            _onClosed(rec);
        };
    }

    // One pair of bus listeners for every chip, rather than one pair per chip.
    const bus = window.feedBack;
    if (bus && typeof bus.on === 'function') {
        bus.on('panes:opened', (e) => {
            const rec = attached.get(e.detail && e.detail.id);
            if (rec) _onOpened(rec);
        });
        bus.on('panes:closed', (e) => {
            const rec = attached.get(e.detail && e.detail.id);
            if (rec) _onClosed(rec);
        });
    }

    window.feedBack.panes.attachChip = attachChip;
})();
