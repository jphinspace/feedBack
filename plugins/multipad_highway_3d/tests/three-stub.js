// Minimal fake of the slice of the Three.js API `04-renderer.js` actually
// calls - enough for `initScene()` and a `draw()` cycle to run start-to-end
// without throwing, so tests can exercise real renderer/scene-building code
// instead of only the pure helpers exposed via `__test`.
//
// This is NOT a WebGL implementation and does no geometric math - shapes,
// positions, and buffers are tracked structurally (right field names, right
// shapes) but hold placeholder values. It exists to catch "this throws" /
// "this never got created" / "this never got disposed" class bugs (the kind
// a screenshot doesn't catch until someone happens to look at the right
// frame), not to verify visual correctness - that's still Playwright's job.
//
// Each call to createThreeStub() returns an independent set of classes, so
// tests don't share mutable state through the fake module.

function createThreeStub() {
    class ColorLike {
        constructor(hex) {
            this._hex = typeof hex === 'number' ? hex : 0;
        }
        setHex(hex) {
            this._hex = hex;
            return this;
        }
        getHex() {
            return this._hex;
        }
        clone() {
            return new ColorLike(this._hex);
        }
    }

    function makeVec3(x, y, z) {
        return {
            x: x || 0,
            y: y || 0,
            z: z || 0,
            set(nx, ny, nz) {
                this.x = nx;
                this.y = ny;
                this.z = nz;
                return this;
            },
            setScalar(s) {
                this.x = s;
                this.y = s;
                this.z = s;
                return this;
            },
            copy(o) {
                this.x = o.x;
                this.y = o.y;
                this.z = o.z;
                return this;
            },
            clone() {
                return makeVec3(this.x, this.y, this.z);
            },
        };
    }

    class Object3D {
        constructor() {
            this.position = makeVec3();
            this.scale = makeVec3(1, 1, 1);
            this.rotation = makeVec3();
            this.children = [];
            this.parent = null;
            this.visible = true;
            this.renderOrder = 0;
            this.frustumCulled = true;
            this.userData = {};
        }
        add(...objs) {
            for (const obj of objs) {
                if (!obj) continue;
                obj.parent = this;
                this.children.push(obj);
            }
            return this;
        }
        remove(...objs) {
            for (const obj of objs) {
                const i = this.children.indexOf(obj);
                if (i >= 0) {
                    this.children.splice(i, 1);
                    obj.parent = null;
                }
            }
            return this;
        }
        traverse(callback) {
            callback(this);
            for (const child of this.children) child.traverse(callback);
        }
        lookAt() {
            return this;
        }
    }

    class Group extends Object3D {}

    class Mesh extends Object3D {
        constructor(geometry, material) {
            super();
            this.geometry = geometry || null;
            this.material = material || null;
        }
    }
    class Line extends Mesh {}
    class LineSegments extends Mesh {}
    class Points extends Mesh {}

    class Sprite extends Object3D {
        constructor(material) {
            super();
            this.material = material || null;
            this.isSprite = true;
        }
    }

    class Vector3 {
        constructor(x, y, z) {
            this.x = x || 0;
            this.y = y || 0;
            this.z = z || 0;
        }
        clone() {
            return new Vector3(this.x, this.y, this.z);
        }
        copy(o) {
            this.x = o.x;
            this.y = o.y;
            this.z = o.z;
            return this;
        }
    }

    class Scene extends Object3D {
        constructor() {
            super();
            this.background = null;
            this.fog = null;
        }
    }

    class Fog {
        constructor(color, near, far) {
            this.color = new ColorLike(color);
            this.near = near;
            this.far = far;
        }
    }

    class Light extends Object3D {
        constructor(color, intensity) {
            super();
            this.color = new ColorLike(color);
            this.intensity = intensity;
        }
    }
    class AmbientLight extends Light {}
    class DirectionalLight extends Light {}

    class PerspectiveCamera extends Object3D {
        constructor(fov, aspect, near, far) {
            super();
            this.fov = fov;
            this.aspect = aspect;
            this.near = near;
            this.far = far;
        }
        updateProjectionMatrix() {}
    }

    class WebGLRenderer {
        constructor(opts) {
            this.domElement = (opts && opts.canvas) || null;
            this.disposed = false;
        }
        setClearColor() {}
        setPixelRatio() {}
        setSize() {}
        render() {}
        dispose() {
            this.disposed = true;
        }
    }

    // Fake position attribute pre-populated onto ShapeGeometry, since
    // makeRoundedNoteFaceGeometry() immediately reads pos.count/getX/getY
    // off the geometry it just built to derive UVs.
    function makeFakePositionAttribute(count) {
        return {
            count: count || 4,
            getX() {
                return 0;
            },
            getY() {
                return 0;
            },
        };
    }

    class BufferGeometryLike {
        constructor() {
            this.attributes = {};
            this.disposed = false;
        }
        setAttribute(name, attr) {
            this.attributes[name] = attr;
            return this;
        }
        setFromPoints(points) {
            this._points = points || [];
            return this;
        }
        translate() {
            return this;
        }
        dispose() {
            this.disposed = true;
        }
    }
    class BufferGeometry extends BufferGeometryLike {}
    class ExtrudeGeometry extends BufferGeometryLike {
        constructor(shape, opts) {
            super();
            this.shape = shape;
            this.opts = opts;
        }
    }
    class ShapeGeometry extends BufferGeometryLike {
        constructor(shape, segments) {
            super();
            this.shape = shape;
            this.segments = segments;
            this.attributes.position = makeFakePositionAttribute();
        }
    }
    class CircleGeometry extends BufferGeometryLike {
        constructor(radius, segments) {
            super();
            this.radius = radius;
            this.segments = segments;
        }
    }
    class RingGeometry extends BufferGeometryLike {
        constructor(innerRadius, outerRadius, segments) {
            super();
            this.innerRadius = innerRadius;
            this.outerRadius = outerRadius;
            this.segments = segments;
        }
    }
    class PlaneGeometry extends BufferGeometryLike {
        constructor(w, h) {
            super();
            this.w = w;
            this.h = h;
        }
    }
    class IcosahedronGeometry extends BufferGeometryLike {
        constructor(radius, detail) {
            super();
            this.radius = radius;
            this.detail = detail;
        }
    }
    class TorusGeometry extends BufferGeometryLike {
        constructor(radius, tube, radialSegments, tubularSegments) {
            super();
            this.radius = radius;
            this.tube = tube;
            this.radialSegments = radialSegments;
            this.tubularSegments = tubularSegments;
        }
    }

    class BufferAttribute {
        constructor(array, itemSize) {
            this.array = array;
            this.itemSize = itemSize;
            this.needsUpdate = false;
            this.count = itemSize ? Math.floor((array ? array.length : 0) / itemSize) : (array ? array.length : 0);
        }
        setUsage() {
            return this;
        }
        getX(i) {
            return this.array[i * this.itemSize] || 0;
        }
        getY(i) {
            return this.array[i * this.itemSize + 1] || 0;
        }
    }
    class Float32BufferAttribute extends BufferAttribute {}

    class Shape {
        constructor() {
            this.holes = [];
        }
        moveTo() {
            return this;
        }
        lineTo() {
            return this;
        }
        quadraticCurveTo() {
            return this;
        }
        getPoints() {
            return [];
        }
    }

    class CanvasTexture {
        constructor(canvasEl) {
            this.image = canvasEl;
            this.needsUpdate = false;
        }
        dispose() {}
    }

    class Material {
        constructor(opts) {
            opts = opts || {};
            this.transparent = !!opts.transparent;
            this.opacity = opts.opacity != null ? opts.opacity : 1;
            this.depthWrite = opts.depthWrite != null ? opts.depthWrite : true;
            this.depthTest = opts.depthTest != null ? opts.depthTest : true;
            this.side = opts.side;
            this.blending = opts.blending;
            this.wireframe = !!opts.wireframe;
            this.vertexColors = !!opts.vertexColors;
            this.sizeAttenuation = !!opts.sizeAttenuation;
            this.metalness = opts.metalness;
            this.roughness = opts.roughness;
            this.emissiveIntensity = opts.emissiveIntensity;
            this.size = opts.size;
            this.map = opts.map || null;
            this.color = new ColorLike(typeof opts.color === 'number' ? opts.color : 0xffffff);
            this.emissive = new ColorLike(typeof opts.emissive === 'number' ? opts.emissive : 0x000000);
            this.disposed = false;
        }
        clone() {
            const copy = new this.constructor();
            Object.assign(copy, this);
            copy.color = this.color.clone();
            copy.emissive = this.emissive.clone();
            return copy;
        }
        copy(source) {
            Object.assign(this, source);
            this.color = source.color ? source.color.clone() : this.color;
            this.emissive = source.emissive ? source.emissive.clone() : this.emissive;
            return this;
        }
        dispose() {
            this.disposed = true;
        }
    }
    class MeshBasicMaterial extends Material {}
    class MeshStandardMaterial extends Material {}
    class LineBasicMaterial extends Material {}
    class PointsMaterial extends Material {}
    class SpriteMaterial extends Material {}

    return {
        Scene,
        Group,
        Mesh,
        Line,
        LineSegments,
        Points,
        Sprite,
        Vector3,
        Fog,
        Color: ColorLike,
        AmbientLight,
        DirectionalLight,
        PerspectiveCamera,
        WebGLRenderer,
        BufferGeometry,
        ExtrudeGeometry,
        ShapeGeometry,
        CircleGeometry,
        RingGeometry,
        PlaneGeometry,
        IcosahedronGeometry,
        TorusGeometry,
        BufferAttribute,
        Float32BufferAttribute,
        Shape,
        CanvasTexture,
        MeshBasicMaterial,
        MeshStandardMaterial,
        LineBasicMaterial,
        PointsMaterial,
        SpriteMaterial,
        DoubleSide: 'DoubleSide',
        AdditiveBlending: 'AdditiveBlending',
        DynamicDrawUsage: 'DynamicDrawUsage',
        LinearFilter: 'LinearFilter',
        SRGBColorSpace: 'SRGBColorSpace',
    };
}

module.exports = { createThreeStub };
