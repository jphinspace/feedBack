/*
 * fee[dB]ack — pane streams.
 *
 * The main realm's sampler for high-rate numeric data a pane wants to display:
 * the playhead, and audio levels.
 *
 * Why a sampler rather than letting panes read the sources directly:
 *
 *   1. An AnalyserNode cannot cross a window boundary. A popped-out pane can
 *      never hold one. So levels must be reduced to plain numbers HERE, in the
 *      realm that owns the audio graph, and shipped as numbers. Making the
 *      docked path work the same way is what keeps one `mount()` valid in both
 *      realms.
 *   2. Per the plugin performance rules, playback-tied loops must stop when
 *      nothing is looking at them. One shared rAF loop, reference-counted
 *      against live subscriptions, is strictly cheaper than N plugin loops —
 *      and it stops dead when the last pane closes.
 *
 * Exposes `window.__fbPaneStreams` (host-internal; panes reach this through
 * ctx.subscribe()).
 */
(function () {
    'use strict';

    // Sources are sampled every frame; a source that returns `undefined` is
    // simply unavailable right now (no stems plugin, no song loaded) and its
    // subscribers are not called at all — better than feeding them zeros they'd
    // render as a real silent signal.
    const SOURCES = {
        // { t, duration, playing } — the transport position.
        playhead() {
            const hw = window.highway;
            if (!hw || typeof hw.getTime !== 'function') return undefined;
            const t = hw.getTime();
            if (!Number.isFinite(t)) return undefined;
            const info = (typeof hw.getSongInfo === 'function' && hw.getSongInfo()) || {};
            const bus = window.feedBack;
            return {
                t: t,
                duration: Number.isFinite(info.duration) ? info.duration : 0,
                playing: !!(bus && bus.isPlaying),
            };
        },

        // { master } — 0..1 RMS of the master bus.
        //
        // Read from the stems plugin's analyser when present. It mutes the core
        // <audio> element and routes everything through its own graph, so its
        // analyser is the only honest tap; with no stems plugin there is no
        // analyser to read and the stream stays silent (subscribers see nothing
        // and can render an "unavailable" state) rather than reporting zeros.
        meters() {
            const stems = window.feedBack && window.feedBack.stems;
            if (!stems || typeof stems.getAnalyser !== 'function') return undefined;
            const an = stems.getAnalyser();
            if (!an || typeof an.getFloatTimeDomainData !== 'function') return undefined;
            const n = an.fftSize;
            // One buffer for the life of the analyser — allocating a
            // Float32Array per frame is exactly the GC churn the perf rules warn
            // about. Re-allocate only if fftSize changed under us.
            if (!_buf || _buf.length !== n) _buf = new Float32Array(n);
            an.getFloatTimeDomainData(_buf);
            let sum = 0;
            for (let i = 0; i < n; i++) sum += _buf[i] * _buf[i];
            return { master: Math.sqrt(sum / n) };
        },
    };

    let _buf = null;

    // stream name -> Set<fn>
    const subs = new Map();
    // stream name -> last value posted, for dirty-checking
    const last = new Map();
    let rafId = null;

    function _changed(name, value) {
        const prev = last.get(name);
        if (prev === undefined && value === undefined) return false;
        if (prev === undefined || value === undefined) return true;
        // Values are flat objects of numbers/booleans — a key-wise compare is
        // enough and avoids JSON.stringify on a 60 Hz path.
        for (const k in value) if (prev[k] !== value[k]) return true;
        for (const k in prev) if (!(k in value)) return true;
        return false;
    }

    function tick() {
        rafId = null;
        let live = false;
        subs.forEach((set_, name) => {
            if (!set_.size) return;
            live = true;
            const src = SOURCES[name];
            const value = src ? src() : undefined;
            // Dirty-check before fanning out. While paused the playhead is
            // constant and the meters are silent — this drops ~60 no-op
            // callbacks per second per pane to zero.
            if (!_changed(name, value)) return;
            last.set(name, value);
            if (value === undefined) return;   // unavailable: stay quiet
            set_.forEach((fn) => { try { fn(value); } catch (e) { console.error('[panes] stream subscriber threw', e); } });
        });
        if (live) rafId = requestAnimationFrame(tick);
    }

    function _kick() {
        if (rafId == null) rafId = requestAnimationFrame(tick);
    }

    function subscribe(name, fn) {
        if (!SOURCES[name]) {
            console.warn('[panes] unknown stream:', name, '— known:', Object.keys(SOURCES).join(', '));
            return () => {};
        }
        if (typeof fn !== 'function') return () => {};
        let set_ = subs.get(name);
        if (!set_) { set_ = new Set(); subs.set(name, set_); }
        set_.add(fn);
        // Forget the dirty-check baseline so a fresh subscriber gets the current
        // value on the next frame instead of waiting for it to change.
        last.delete(name);
        _kick();
        return () => {
            set_.delete(fn);
            // The loop stops itself on the next tick when nothing is subscribed.
        };
    }

    function activeStreams() {
        const out = [];
        subs.forEach((set_, name) => { if (set_.size) out.push(name); });
        return out;
    }

    window.__fbPaneStreams = { subscribe, activeStreams, sources: () => Object.keys(SOURCES) };
})();
