// Minimal fake DOM + 2D canvas context - just enough for
// multipad_highway_3d's label-sprite text layout (createLabelSprite) and
// player-controls button injection code to run against in tests.
//
// Not a real DOM/canvas - no rendering, no CSS, no event bubbling beyond
// directly invoking handlers assigned by the code under test (e.g.
// `el.onclick()`). Structural fake in the same spirit as three-stub.js:
// enough shape to catch "this throws" / "this landed in the wrong
// container" bugs, not a browser-fidelity implementation.

function createDomStub() {
    const byId = new Map();

    function makeClassList(el) {
        return {
            add(...cls) {
                for (const c of cls) if (c && !el._classes.includes(c)) el._classes.push(c);
            },
            remove(...cls) {
                el._classes = el._classes.filter(c => !cls.includes(c));
            },
            contains(c) {
                return el._classes.includes(c);
            },
            toggle(c, force) {
                const has = el._classes.includes(c);
                const want = force === undefined ? !has : !!force;
                if (want && !has) el._classes.push(c);
                if (!want && has) el._classes = el._classes.filter(x => x !== c);
                return want;
            },
        };
    }

    // Fake 2D context for createLabelSprite's shrink-to-fit text layout.
    // measureText is a deterministic stand-in (proportional to string
    // length and the px size parsed out of the current `font` string) -
    // not pixel-accurate, but enough for the shrink-loop's real branches
    // (long text at a big font size "overflows" and shrinks; short text or
    // a small enough font does not) to actually execute in tests.
    function make2dContext(canvas) {
        return {
            canvas,
            font: '',
            textAlign: '',
            textBaseline: '',
            lineWidth: 1,
            strokeStyle: '',
            fillStyle: '',
            strokeCalls: [],
            fillCalls: [],
            clearRect() {},
            measureText(text) {
                const m = /(\d+)px/.exec(this.font);
                const px = m ? Number(m[1]) : 16;
                return { width: String(text).length * px * 0.6 };
            },
            strokeText(text, x, y) { this.strokeCalls.push({ text, x, y, font: this.font }); },
            fillText(text, x, y) { this.fillCalls.push({ text, x, y, font: this.font }); },
        };
    }

    function makeElement(tag) {
        const isCanvas = tag === 'canvas';
        const el = {
            tagName: String(tag || '').toUpperCase(),
            id: '',
            _classes: [],
            children: [],
            parentNode: null,
            attributes: {},
            dataset: {},
            style: {},
            textContent: '',
            title: '',
            type: '',
            disabled: false,
            width: 0,
            height: 0,
            get className() { return this._classes.join(' '); },
            set className(v) { this._classes = String(v || '').split(/\s+/).filter(Boolean); },
            setAttribute(k, v) {
                this.attributes[k] = String(v);
                if (k === 'id') this.id = String(v);
            },
            getAttribute(k) {
                return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null;
            },
            appendChild(child) {
                child.parentNode = this;
                this.children.push(child);
                if (child.id) byId.set(child.id, child);
                return child;
            },
            insertBefore(child, ref) {
                child.parentNode = this;
                const idx = this.children.indexOf(ref);
                if (idx === -1) this.children.push(child);
                else this.children.splice(idx, 0, child);
                if (child.id) byId.set(child.id, child);
                return child;
            },
            removeChild(child) {
                this.children = this.children.filter(c => c !== child);
                if (child.parentNode === this) child.parentNode = null;
                return child;
            },
            contains(node) {
                let n = node;
                while (n) {
                    if (n === this) return true;
                    n = n.parentNode;
                }
                return false;
            },
            querySelector() { return null; },
            querySelectorAll() { return []; },
        };
        el.classList = makeClassList(el);
        if (isCanvas) {
            // Cache the context instance per element (matches real
            // HTMLCanvasElement.getContext semantics) so a test can call
            // canvas.getContext('2d') again later and see the same
            // fillCalls/strokeCalls createLabelSprite recorded.
            let ctx2d = null;
            el.getContext = type => {
                if (type !== '2d') return null;
                if (!ctx2d) ctx2d = make2dContext(el);
                return ctx2d;
            };
        }
        return el;
    }

    const doc = {
        _activeScreenId: null,
        createElement: makeElement,
        getElementById(id) {
            return byId.has(id) ? byId.get(id) : null;
        },
        querySelector(sel) {
            if (sel === '.screen.active' && doc._activeScreenId) {
                return byId.get(doc._activeScreenId) || null;
            }
            return null;
        },
    };

    return {
        document: doc,
        /** Register a pre-built element (e.g. a standalone `#player-controls`
         * container never appended to anything else) so getElementById finds it. */
        registerElement(el) {
            if (el.id) byId.set(el.id, el);
        },
    };
}

module.exports = { createDomStub };
