/*
 * fee[dB]ack — pane dock (the in-window pane host).
 *
 * A right-edge stack of cards, one per open pane. Deliberately NOT a rail
 * popover: the rail is exclusive (player-chrome.js openPopFor closes the last
 * one before opening the next), which is precisely why you can't watch the
 * mixer while riding the camera. Cards here coexist.
 *
 * Song-switch survival is structural, not defended. `#fb-pane-dock` is appended
 * to <body>, outside every `.screen`, so the per-song teardown never sees it —
 * and `playSong()` ends in `showScreen('player')`, whose id === 'player' short-
 * circuits the teardown branch anyway. Nothing to reset, nothing to re-mount.
 *
 * Registers itself as the `dock` host at priority 0 — the floor. Whatever else
 * exists (an OS pane window), a pane can always land here.
 */
(function () {
    'use strict';

    const panes = window.feedBack && window.feedBack.panes;
    if (!panes || typeof panes.registerHost !== 'function') {
        console.error('[panes] pane-manager.js must load before pane-dock.js');
        return;
    }

    let dockEl = null;
    const cards = new Map();   // paneId -> card element

    function dock() {
        if (dockEl && dockEl.isConnected) return dockEl;
        dockEl = document.getElementById('fb-pane-dock');
        if (!dockEl) {
            dockEl = document.createElement('div');
            dockEl.id = 'fb-pane-dock';
            dockEl.className = 'fb-pane-dock';
            dockEl.setAttribute('role', 'region');
            dockEl.setAttribute('aria-label', 'Panes');
            document.body.appendChild(dockEl);
        }
        return dockEl;
    }

    function _syncEmpty() {
        const d = dock();
        d.classList.toggle('is-empty', cards.size === 0);
    }

    function mount(spec) {
        const card = document.createElement('section');
        card.className = 'fb-pane-card';
        card.dataset.paneId = spec.id;
        card.setAttribute('aria-label', spec.title);

        const head = document.createElement('header');
        head.className = 'fb-pane-card-head';

        const title = document.createElement('span');
        title.className = 'fb-pane-card-title';
        // textContent, not innerHTML — a pane title can come from a plugin
        // manifest, i.e. from outside core.
        title.textContent = spec.icon + ' ' + spec.title;

        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'fb-pane-card-btn';
        close.setAttribute('aria-label', 'Close ' + spec.title);
        close.title = 'Close';
        close.textContent = '✕';
        close.addEventListener('click', () => panes.close(spec.id));

        head.appendChild(title);
        head.appendChild(close);

        const body = document.createElement('div');
        body.className = 'fb-pane-card-body fb-selectable';

        card.appendChild(head);
        card.appendChild(body);
        dock().appendChild(card);
        cards.set(spec.id, card);
        _syncEmpty();

        // The pane mounts into the body, never the card — so it cannot reach
        // (or accidentally destroy) the chrome that owns its close button.
        return body;
    }

    function unmount(id) {
        const card = cards.get(id);
        if (card) card.remove();
        cards.delete(id);
        _syncEmpty();
    }

    function focus(id) {
        const card = cards.get(id);
        if (!card) return;
        card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        // Re-trigger the flash even if the class is already there (repeat focus
        // of the same card would otherwise be a no-op animation).
        card.classList.remove('is-flash');
        void card.offsetWidth;
        card.classList.add('is-flash');
        setTimeout(() => card.classList.remove('is-flash'), 700);
    }

    panes.registerHost({ id: 'dock', priority: 0, available: () => !!document.body, mount, unmount, focus });
})();
