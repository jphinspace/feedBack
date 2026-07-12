/*
 * fee[dB]ack — Mixer pane (built-in).
 *
 * The same faders as the rail's mixer popover, in a pane that stays open.
 *
 * Two reasons this exists rather than "pop out the existing popover":
 *
 *   1. It is the second half of the chip proof. This file attaches the standard
 *      ⇱ chip to the EXISTING `#mixer-control` in the rail — real core UI we
 *      already own — so popping out hides the rail mixer and leaves the stub in
 *      its place. No new dialog was invented to demo the flow.
 *   2. It talks to the `audio-mix` capability bus through `ctx.call()` and to
 *      nothing else. That is what makes it realm-portable: the rail popover
 *      reaches into `window.feedBack.capabilities` directly and could never
 *      survive a move into a pop-out window; this can.
 *
 * The mixer registry deliberately stores specs, not values — each fader's owner
 * persists its own. So this pane persists nothing either (`persist: false`); it
 * reads the live values every time it opens.
 */
(function () {
    'use strict';

    const panes = window.feedBack && window.feedBack.panes;
    if (!panes) return;

    function fmt(v, unit) {
        const s = v === Math.round(v) ? v.toFixed(0) : v.toFixed(2);
        return unit ? s + unit : s;
    }

    function strip(fader, ctx) {
        const min = Number(fader.min), max = Number(fader.max);
        let cur = Number(fader.currentValue);
        if (!Number.isFinite(cur)) cur = Number(fader.defaultValue) || 0;
        cur = Math.min(max, Math.max(min, cur));
        const available = fader.availability === 'available' && fader.userAdjustable !== false;

        const wrap = document.createElement('div');
        wrap.className = 'fb-pane-row';

        const label = document.createElement('span');
        label.className = 'fb-pane-key';
        label.textContent = fader.label || fader.faderLabel || fader.faderId || fader.id;

        const slider = document.createElement('input');
        slider.type = 'range';
        slider.className = 'accent-accent slider-input';
        slider.min = String(min);
        slider.max = String(max);
        slider.step = String(fader.step);
        slider.value = String(cur);
        slider.disabled = !available;
        slider.setAttribute('aria-label', label.textContent + ' volume');

        const value = document.createElement('span');
        value.className = 'fb-pane-val is-num';
        value.textContent = available ? fmt(cur, fader.unit) : 'Unavailable';

        // A drag fires `input` faster than the capability round-trip resolves, so
        // responses can land out of order. Only the newest write may paint.
        let seq = 0;
        slider.addEventListener('input', () => {
            if (slider.disabled) return;
            const mine = ++seq;
            const requested = parseFloat(slider.value);
            ctx.call('audio-mix', 'set-fader-value', {
                participantId: fader.participantId,
                faderId: fader.faderId || fader.id,
                value: Number.isFinite(requested) ? requested : cur,
            }).then((result) => {
                if (mine !== seq) return;
                const payload = (result && result.payload) || {};
                const committed = Number(payload.committedValue);
                if (Number.isFinite(committed)) {
                    cur = Math.min(max, Math.max(min, committed));
                    slider.value = String(cur);
                }
                value.textContent = (result && result.outcome === 'handled') ? fmt(cur, fader.unit) : 'Failed';
            }).catch(() => {
                if (mine !== seq) return;
                slider.value = String(cur);
                value.textContent = 'Failed';
            });
        });

        wrap.appendChild(label);
        wrap.appendChild(slider);
        wrap.appendChild(value);
        return wrap;
    }

    panes.register({
        id: 'core_mixer',
        title: 'Mixer',
        icon: '🎚',
        persist: false,
        // Faders come and go with the song (a song with no stems unregisters
        // them), so the pane has to hear about it. These ride on top of the
        // default event allowlist.
        events: [
            'audio-mix:participant-registered',
            'audio-mix:participant-removed',
            'audio-mix:fader-unavailable',
        ],

        mount(root, ctx) {
            const list = document.createElement('div');
            root.appendChild(list);

            let renderSeq = 0;
            function render() {
                const mine = ++renderSeq;
                ctx.call('audio-mix', 'list-faders', {}).then((result) => {
                    if (mine !== renderSeq) return;   // a newer render superseded us
                    const faders = (result && result.payload && Array.isArray(result.payload.faders))
                        ? result.payload.faders : [];
                    list.replaceChildren();
                    if (!faders.length) {
                        const empty = document.createElement('div');
                        empty.className = 'fb-pane-dim';
                        empty.textContent = 'No audio sources.';
                        list.appendChild(empty);
                        return;
                    }
                    faders.forEach((f) => list.appendChild(strip(f, ctx)));
                }).catch((err) => {
                    if (mine !== renderSeq) return;
                    console.error('[panes] mixer: list-faders failed', err);
                    list.replaceChildren();
                    const oops = document.createElement('div');
                    oops.className = 'fb-pane-dim';
                    oops.textContent = 'Mixer unavailable.';
                    list.appendChild(oops);
                });
            }

            render();
            ctx.on('audio-mix:participant-registered', render);
            ctx.on('audio-mix:participant-removed', render);
            ctx.on('audio-mix:fader-unavailable', render);
            // A new song brings a new set of stems.
            ctx.on('song:ready', render);
        },

        unmount(root) {
            root.replaceChildren();
        },
    });

    // The chip, on the real rail mixer. Hiding #mixer-control (button + popover)
    // rather than #mixer-popover alone means the rail doesn't keep offering a
    // "Mixer ▾" button that opens an empty popover while the pane owns the faders.
    function _attach() {
        const el = document.getElementById('mixer-control');
        if (!el) return;
        panes.attachChip(el, 'core_mixer');
    }
    if (document.readyState !== 'complete') document.addEventListener('DOMContentLoaded', _attach);
    else _attach();
})();
