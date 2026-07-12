/*
 * fee[dB]ack — "Now Playing" pane (built-in).
 *
 * The reference pane, and the one that proves the contract: it reads song
 * metadata off the mirrored event bus, a playhead off a stream, and audio levels
 * off a stream that only exists when the stems plugin does. It touches
 * `window.feedBack`, `window.highway` and the audio graph exactly zero times —
 * everything comes through `ctx` — which is what will let it run unchanged
 * inside a pop-out window, where none of those globals exist.
 *
 * Read this before writing a pane of your own.
 */
(function () {
    'use strict';

    const panes = window.feedBack && window.feedBack.panes;
    if (!panes) return;

    function row(parent, key) {
        const r = document.createElement('div');
        r.className = 'fb-pane-row';
        const k = document.createElement('span');
        k.className = 'fb-pane-key';
        k.textContent = key;
        const v = document.createElement('span');
        v.className = 'fb-pane-val';
        r.appendChild(k);
        r.appendChild(v);
        parent.appendChild(r);
        return v;
    }

    function fmtTime(s) {
        if (!Number.isFinite(s) || s < 0) s = 0;
        const m = Math.floor(s / 60);
        return m + ':' + String(Math.floor(s % 60)).padStart(2, '0');
    }

    panes.register({
        id: 'now_playing',
        title: 'Now Playing',
        icon: '🎵',
        // How the pane REALM loads this same file to get the same mount(). A pane
        // with no `script` can only ever be docked.
        script: '/static/panes/builtin/now-playing.js',
        // Levels are transient; nothing here is worth remembering across a reload.
        persist: false,

        mount(root, ctx) {
            const title = row(root, 'Song');
            const artist = row(root, 'Artist');
            const arr = row(root, 'Arrangement');
            const tuning = row(root, 'Tuning');

            const timeVal = row(root, 'Position');
            timeVal.classList.add('is-num');
            const bar = document.createElement('div');
            bar.className = 'fb-pane-bar';
            const fill = document.createElement('div');
            fill.className = 'fb-pane-bar-fill';
            bar.appendChild(fill);
            root.appendChild(bar);

            const levelLabel = document.createElement('div');
            levelLabel.className = 'fb-pane-dim';
            levelLabel.style.marginTop = '.6rem';
            levelLabel.textContent = 'Level — no stems plugin';
            const level = document.createElement('div');
            level.className = 'fb-pane-bar';
            const levelFill = document.createElement('div');
            levelFill.className = 'fb-pane-bar-fill is-level';
            level.appendChild(levelFill);
            root.appendChild(levelLabel);
            root.appendChild(level);

            function renderSong() {
                const s = ctx.song();
                title.textContent = (s && s.title) || '—';
                artist.textContent = (s && s.artist) || '—';
                arr.textContent = (s && (s.arrangementSmartName || s.arrangement)) || '—';
                tuning.textContent = (s && Array.isArray(s.tuning)) ? s.tuning.join(' ') : '—';
            }

            renderSong();
            // The mirrored bus. `song:loaded` also fires on an arrangement switch,
            // which is exactly when the arrangement/tuning rows go stale.
            ctx.on('song:loaded', renderSong);

            // Streams, not events: the playhead moves every frame, and
            // `song:position-changed` is throttled to 250 ms — too coarse for a
            // bar, and too chatty to mirror across a window boundary.
            ctx.subscribe('playhead', (p) => {
                timeVal.textContent = fmtTime(p.t) + ' / ' + fmtTime(p.duration);
                const frac = p.duration > 0 ? Math.min(1, Math.max(0, p.t / p.duration)) : 0;
                fill.style.transform = 'scaleX(' + frac.toFixed(4) + ')';
            });

            // The meters stream stays silent when no analyser exists rather than
            // reporting zeros — so a silent stream and real silence are
            // distinguishable, and this label is honest either way.
            ctx.subscribe('meters', (m) => {
                levelLabel.textContent = 'Level';
                levelFill.style.transform = 'scaleX(' + Math.min(1, m.master * 3).toFixed(3) + ')';
            });
        },

        unmount(root) {
            // ctx tears down every subscription it handed out; the pane only owns
            // its DOM.
            root.replaceChildren();
        },
    });
})();
