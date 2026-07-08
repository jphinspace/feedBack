    // ---------------------------------------------------------------------
    // Three.js Renderer
    // ---------------------------------------------------------------------

    /**
     * Project a point at a fixed local offset from the pad grid's own
     * center into tunnel/world space at a given travel progress.
     *
     * The grid's own center converges from a compressed point near
     * `TUNNEL_BACK_X_OFFSET`/`TUNNEL_BACK_LIFT` (progress=0, still far
     * away) to its real position (progress=1, at the target plane).
     * `localOffsetX`/`localOffsetY` - a fixed offset from that center, e.g.
     * a pad's own position within the grid - is added UNSCALED at every
     * progress value, rather than being separately compressed toward the
     * vanishing point on its own.
     *
     * This is the single source of truth: both note gems (`placeNote`) and
     * the whole-hit-group outline (`placeLayoutPreview`) call this same
     * function for their own offset (a pad's own `(surface.x, surface.y -
     * GRID_CENTER_Y)`, or `(0, 0)` for the outline's own center) rather
     * than each hand-rolling its own version of this formula. Letting the
     * two drift apart is exactly what caused three separate bugs across
     * this file's history: gems and the outline growing along different
     * size curves, gem size compounding differently than gem spacing under
     * camera perspective, and (most recently) gem position compressing
     * toward its own point while the outline's did not - putting a
     * just-spawned gem near the *center* of an already-correctly-shaped
     * outline instead of at its real proportional spot within it. With one
     * shared formula, that class of divergence is no longer something to
     * remember to keep in sync - there is nothing else it could drift from.
     *
     * @param {number} localOffsetX - Fixed X offset from the grid's own center.
     * @param {number} localOffsetY - Fixed Y offset from the grid's own center.
     * @param {number} progress - Travel progress; 0 = just spawned (far
     *   away, compressed toward the vanishing point), 1 = at the target plane.
     * @returns {{x: number, y: number}} World-space position.
     */
    function projectGridPoint(localOffsetX, localOffsetY, progress) {
        const centerX = TUNNEL_BACK_X_OFFSET * (1 - progress);
        const centerY = GRID_CENTER_Y + TUNNEL_BACK_LIFT * (1 - progress);
        return { x: centerX + localOffsetX, y: centerY + localOffsetY };
    }

    /**
     * Build one renderer instance for the host setRenderer lifecycle.
     *
     * The renderer keeps all Three.js state instance-local. Stable
     * pad/tunnel geometry, shared note materials, and pooled note meshes live
     * until teardown.
     *
     * @returns {{contextType: string, init: Function, draw: Function, resize: Function, destroy: Function}}
     */
    function createFactory() {
        let canvas = null;
        let lastBundle = null;
        let lastWidth = 0;
        let lastHeight = 0;
        let renderScale = 1;
        let destroyed = false;
        let generation = 0;
        let ready = false;
        let scene = null;
        let camera = null;
        let renderer = null;
        let highwayGroup = null;
        let surfaceGroup = null;
        let notesGroup = null;
        let labelGroup = null;
        let surfaces = Object.create(null);
        let noteGeometry = null;
        let noteFaceGeometry = null;
        let noteMaterials = new Map();
        let noteMeshPool = [];
        let layoutPreviewGroup = null;
        let layoutPreviewGroupFrameGeometry = null;
        let layoutPreviewGroupMaterial = null;
        let layoutPreviewGroupMeshPool = [];
        let visibleLayoutPreviewGroupCount = 0;
        let cachedDrumTab = null;
        let cachedDrumHitCount = -1;
        let cachedProjectionSource = '';
        let cachedProjection = null;
        let cachedSettingsVersion = -1;
        let lastProjectionStats = null;
        let lastZeroProjectionWarningKey = '';
        let activeSurfaceLayoutKey = null;
        let renderCursorProjection = null;
        let renderCursorIndex = 0;
        let renderCursorTime = -Infinity;
        let activeNoteAheadSec = NOTE_AHEAD_FALLBACK_SEC;
        let activeNoteSpawnDepth = NOTE_AHEAD_FALLBACK_SEC * NOTE_SPEED;
        let visibleNoteCount = 0;
        let activeSettings = readSettings();
        let activeThemeId = activeSettings.sceneTheme;
        let floorMesh = null;
        let ambientLight = null;
        let keyLight = null;
        let bgGroup = null;
        let bgState = null;
        let activeBackgroundKey = '';
        let crossedEventFxKeys = new Set();
        let crossingFxProjection = null;
        let crossingFxTime = -Infinity;
        let sparkPoints = null;
        let sparkPos = null;
        let sparkCol = null;
        let sparkVel = null;
        let sparkLife = null;
        let fxLastWall = 0;
        let kickPulse = 0;
        let baseCameraY = 0;

        /**
         * Dispose a Three.js material and its texture map once.
         *
         * @param {object|null} mat - Material-like object to dispose.
         * @param {Set<object>} disposed - Materials already disposed in this pass.
         * @returns {void}
         */
        function disposeMaterial(mat, disposed) {
            if (!mat || disposed.has(mat)) return;
            disposed.add(mat);
            if (mat.map && typeof mat.map.dispose === 'function') mat.map.dispose();
            if (typeof mat.dispose === 'function') mat.dispose();
        }

        /**
         * Dispose every cached note template material (and its gradient
         * texture, via `disposeMaterial`) and reset the cache.
         *
         * These templates are only ever `.clone()`d onto pooled note meshes -
         * the templates themselves never enter the scene graph, so
         * `disposeObjectTree(scene)` never reaches them. Callers that drop
         * `noteMaterials` (settings changes that invalidate cached materials,
         * and teardown) must go through this instead of reassigning
         * `noteMaterials = new Map()` directly, or the old templates and
         * their canvas gradient textures leak silently.
         *
         * @returns {void}
         */
        function disposeNoteMaterials() {
            const disposed = new Set();
            for (const mat of noteMaterials.values()) disposeMaterial(mat, disposed);
            noteMaterials = new Map();
        }

        /**
         * Dispose geometries, materials, and texture maps in an object tree.
         *
         * @param {object|null} root - Three.js object with `traverse`.
         * @returns {void}
         */
        function disposeObjectTree(root) {
            if (!root) return;
            const disposedMaterials = new Set();
            const disposedGeometry = new Set();
            root.traverse(obj => {
                const isSprite = !!(obj && (obj.isSprite || (T && T.Sprite && obj instanceof T.Sprite)));
                if (!isSprite && obj.geometry && !disposedGeometry.has(obj.geometry)) {
                    disposedGeometry.add(obj.geometry);
                    obj.geometry.dispose();
                }
                if (Array.isArray(obj.material)) {
                    for (const mat of obj.material) disposeMaterial(mat, disposedMaterials);
                } else {
                    disposeMaterial(obj.material, disposedMaterials);
                }
            });
        }

        /**
         * Remove an object from whichever parent currently owns it.
         *
         * @param {object|null} obj - Three.js object.
         * @returns {void}
         */
        function removeFromParent(obj) {
            if (obj && obj.parent && typeof obj.parent.remove === 'function') {
                obj.parent.remove(obj);
            }
        }

        /**
         * Apply the shared highway transform used by surfaces, lane guides, and notes.
         *
         * @returns {void}
         */
        function applyHighwayTransform() {
            if (!highwayGroup) return;
            highwayGroup.position.set(0, HIGHWAY_Y_OFFSET, HIGHWAY_Z_OFFSET);
            highwayGroup.rotation.set(HIGHWAY_PITCH, 0, 0);
        }

        /**
         * Hide pooled note groups before rendering the next frame.
         *
         * Stable geometry and materials are shared and disposed during teardown,
         * so note groups can be dropped without disposing those resources here.
         *
         * @returns {void}
         */
        function clearTransientNotes() {
            if (!notesGroup) return;
            for (const entry of noteMeshPool) {
                entry.group.visible = false;
            }
            visibleNoteCount = 0;
        }

        /**
         * Return a reusable note group for this frame.
         *
         * @param {object} material - Body material for the current note variant.
         * @param {object} faceMaterial - Front-face material for the current note variant.
         * @returns {object} Note pool entry.
         */
        function acquireNoteMesh(material, faceMaterial) {
            let entry = noteMeshPool[visibleNoteCount];
            if (!entry) {
                const group = new T.Group();
                const body = new T.Mesh(noteGeometry, material.clone());
                const face = new T.Mesh(noteFaceGeometry, faceMaterial.clone());
                body.position.z = NOTE_GEM_BODY_Z_OFFSET;
                face.position.z = NOTE_GEM_FACE_Z_OFFSET;
                body.renderOrder = 10;
                face.renderOrder = 10;
                body.userData.sourceMaterial = material;
                face.userData.sourceMaterial = faceMaterial;
                group.add(body, face);
                entry = { group, body, face };
                noteMeshPool.push(entry);
                notesGroup.add(group);
            } else {
                if (entry.body.userData.sourceMaterial !== material) {
                    entry.body.material.copy(material);
                    entry.body.userData.sourceMaterial = material;
                }
                if (entry.face.userData.sourceMaterial !== faceMaterial) {
                    entry.face.material.copy(faceMaterial);
                    entry.face.userData.sourceMaterial = faceMaterial;
                }
            }
            entry.group.visible = true;
            visibleNoteCount++;
            return entry;
        }

        /**
         * Hide pooled layout-preview meshes before rendering the next frame.
         *
         * @returns {void}
         */
        function clearTransientLayoutPreviews() {
            if (!layoutPreviewGroup) return;
            for (const entry of layoutPreviewGroupMeshPool) {
                entry.mesh.visible = false;
            }
            visibleLayoutPreviewGroupCount = 0;
        }

        /**
         * Return the shared material for the whole-hit-group outer outline.
         *
         * WebGL ignores `LineBasicMaterial.linewidth` on most platforms (it's
         * clamped to 1px regardless of the value set), so this is drawn as a
         * thin filled frame shape instead of a stroked line - see
         * `buildLayoutPreviewGroupFrameGeometry`.
         *
         * @returns {object} Three.js material.
         */
        function getLayoutPreviewGroupMaterial() {
            if (!layoutPreviewGroupMaterial) {
                layoutPreviewGroupMaterial = new T.MeshBasicMaterial({
                    color: 0xffffff,
                    transparent: true,
                    opacity: LAYOUT_PREVIEW_GROUP_OPACITY,
                    depthWrite: false,
                    side: T.DoubleSide,
                });
            }
            return layoutPreviewGroupMaterial;
        }

        /**
         * Return a reusable whole-hit-group outer outline for this frame.
         *
         * @returns {object} Layout-preview pool entry.
         */
        function acquireLayoutPreviewGroupMesh() {
            const material = getLayoutPreviewGroupMaterial();
            let entry = layoutPreviewGroupMeshPool[visibleLayoutPreviewGroupCount];
            if (!entry) {
                const mesh = new T.Mesh(layoutPreviewGroupFrameGeometry, material.clone());
                // Share note gems' own renderOrder (body/face use 10) rather
                // than a fixed lower value. Three.js only sorts transparent
                // objects by camera distance *within* the same renderOrder -
                // across different renderOrders it draws strictly in
                // renderOrder sequence regardless of depth. A fixed lower
                // renderOrder here meant every outline drew before every
                // gem, so a nearer hit group's outline could get painted
                // over by a farther, still-approaching hit group's gem
                // (drawn later, but at greater camera distance) instead of
                // correctly occluding it. Sharing renderOrder lets Three.js
                // sort outlines and gems together by true distance.
                mesh.renderOrder = 10;
                mesh.userData.sourceGeometry = layoutPreviewGroupFrameGeometry;
                entry = { mesh };
                layoutPreviewGroupMeshPool.push(entry);
                layoutPreviewGroup.add(mesh);
            } else if (entry.mesh.userData.sourceGeometry !== layoutPreviewGroupFrameGeometry) {
                // Cached geometry is shared, not cloned - swap the reference
                // only, never dispose here (buildSurfaceGrid and teardown
                // own disposing it).
                entry.mesh.geometry = layoutPreviewGroupFrameGeometry;
                entry.mesh.userData.sourceGeometry = layoutPreviewGroupFrameGeometry;
            }
            entry.mesh.visible = true;
            visibleLayoutPreviewGroupCount++;
            return entry;
        }

        /**
         * Create a rounded rectangle shape centered on the local origin.
         *
         * @param {number} w - Width.
         * @param {number} h - Height.
         * @param {number} radius - Corner radius.
         * @returns {object} Three.js Shape.
         */
        function makeRoundedRectShape(w, h, radius) {
            return makeRoundedRectShapeAt(0, 0, w, h, radius);
        }

        /**
         * Create a rounded rectangle shape centered on an arbitrary point.
         *
         * @param {number} cx - Center X.
         * @param {number} cy - Center Y.
         * @param {number} w - Width.
         * @param {number} h - Height.
         * @param {number} radius - Corner radius.
         * @returns {object} Three.js Shape.
         */
        function makeRoundedRectShapeAt(cx, cy, w, h, radius) {
            const hw = w / 2;
            const hh = h / 2;
            const r = Math.max(0, Math.min(radius, hw, hh));
            const shape = new T.Shape();
            shape.moveTo(cx - hw + r, cy - hh);
            shape.lineTo(cx + hw - r, cy - hh);
            shape.quadraticCurveTo(cx + hw, cy - hh, cx + hw, cy - hh + r);
            shape.lineTo(cx + hw, cy + hh - r);
            shape.quadraticCurveTo(cx + hw, cy + hh, cx + hw - r, cy + hh);
            shape.lineTo(cx - hw + r, cy + hh);
            shape.quadraticCurveTo(cx - hw, cy + hh, cx - hw, cy + hh - r);
            shape.lineTo(cx - hw, cy - hh + r);
            shape.quadraticCurveTo(cx - hw, cy - hh, cx - hw + r, cy - hh);
            return shape;
        }

        /**
         * Build a thin rectangular frame (border-only, hollow center) shape
         * geometry: an outer rounded rect with a smaller rounded rect cut out
         * as a hole, leaving just a `thickness`-wide ring. Filled geometry
         * gives reliable, controllable thickness - WebGL clamps
         * `LineBasicMaterial.linewidth` to 1px on most platforms, so a
         * stroked `Line` can't be made visibly thicker.
         *
         * @param {number} w - Outer width.
         * @param {number} h - Outer height.
         * @param {number} thickness - Frame thickness in the same units as w/h.
         * @param {number} radius - Outer corner radius, in the same units as w/h.
         * @returns {object} Three.js ShapeGeometry.
         */
        function buildFrameGeometry(w, h, thickness, radius) {
            const shape = makeRoundedRectShape(w, h, radius);
            const innerW = Math.max(0.001, w - thickness * 2);
            const innerH = Math.max(0.001, h - thickness * 2);
            const innerRadius = Math.max(0, radius - thickness);
            shape.holes.push(makeRoundedRectShape(innerW, innerH, innerRadius));
            return new T.ShapeGeometry(shape, NOTE_GEM_CURVE_SEGMENTS);
        }

        /**
         * Build the whole-hit-group outer outline frame geometry, spanning
         * the current pad grid's full bounding box plus a small margin so
         * the frame doesn't touch the outermost gems. Rebuilt whenever the
         * pad profile changes (grid dimensions can change).
         *
         * @param {number} gridW - Grid bounding box width.
         * @param {number} gridH - Grid bounding box height.
         * @returns {object} Three.js ShapeGeometry.
         */
        function buildLayoutPreviewGroupFrameGeometry(gridW, gridH) {
            return buildFrameGeometry(
                gridW + LAYOUT_PREVIEW_GROUP_MARGIN * 2,
                gridH + LAYOUT_PREVIEW_GROUP_MARGIN * 2,
                0.07,
                LAYOUT_PREVIEW_GROUP_CORNER_RADIUS
            );
        }

        /**
         * Create the shared rounded-rectangle geometry for incoming note gems.
         *
         * @returns {object} Three.js geometry centered on the local origin.
         */
        function makeRoundedNoteGeometry() {
            const shape = makeRoundedRectShape(1, 1, NOTE_GEM_CORNER_RADIUS);
            const geo = new T.ExtrudeGeometry(shape, {
                depth: NOTE_GEM_DEPTH,
                bevelEnabled: false,
                curveSegments: NOTE_GEM_CURVE_SEGMENTS,
            });
            geo.translate(0, 0, -NOTE_GEM_DEPTH / 2);
            return geo;
        }

        /**
         * Create the shared rounded front face for incoming note gems.
         *
         * Explicit UVs make the note gradient predictable across browsers and
         * independent of ExtrudeGeometry side/front UV generation.
         *
         * @returns {object} Three.js shape geometry centered on the local origin.
         */
        function makeRoundedNoteFaceGeometry() {
            const geo = new T.ShapeGeometry(makeRoundedRectShape(1, 1, NOTE_GEM_CORNER_RADIUS), NOTE_GEM_CURVE_SEGMENTS);
            const pos = geo.attributes.position;
            const uv = [];
            for (let i = 0; i < pos.count; i++) {
                uv.push(pos.getX(i) + 0.5, pos.getY(i) + 0.5);
            }
            geo.setAttribute('uv', new T.Float32BufferAttribute(uv, 2));
            return geo;
        }

        /**
         * Create a flat rounded rectangle surface geometry.
         *
         * @param {number} w - Width.
         * @param {number} h - Height.
         * @returns {object} Three.js geometry.
         */
        function makeRoundedSurfaceGeometry(w, h) {
            const r = Math.min(w, h) * NOTE_GEM_CORNER_RADIUS;
            return new T.ShapeGeometry(makeRoundedRectShape(w, h, r), NOTE_GEM_CURVE_SEGMENTS);
        }

        /**
         * Create a rounded rectangle outline geometry.
         *
         * @param {number} w - Width.
         * @param {number} h - Height.
         * @returns {object} Three.js geometry.
         */
        function makeRoundedSurfaceEdgeGeometry(w, h) {
            const r = Math.min(w, h) * NOTE_GEM_CORNER_RADIUS;
            const points = makeRoundedRectShape(w, h, r).getPoints(NOTE_GEM_CURVE_SEGMENTS);
            if (points.length) points.push(points[0].clone());
            return new T.BufferGeometry().setFromPoints(points);
        }

        /**
         * Resolve the display color for a projected drum event.
         *
         * @param {object} event - Projected hit event from `projectDrumTab`.
         * @returns {number} Three.js hex color.
         */
        function eventColorForEvent(event) {
            const profileColor = colorHexFromCss(event && event.color);
            if (profileColor !== null) return profileColor;
            return (event && (PIECE_COLORS[event.piece] || PIECE_COLORS[event.routedPiece])) || 0x93c5fd;
        }

        function timingHex(event) {
            if (!activeSettings.timingColors) return TIMING_OK_COLOR;
            const status = normalizeTimingStatus(event && event.timingStatus);
            if (status === 'EARLY') return TIMING_EARLY_COLOR;
            if (status === 'LATE') return TIMING_LATE_COLOR;
            return TIMING_OK_COLOR;
        }

        function sparkBurst(x, y, z, hex, count) {
            if (!activeSettings.hitSparks || !sparkPoints || !sparkLife || count <= 0) return;
            const r = ((hex >> 16) & 255) / 255;
            const g = ((hex >> 8) & 255) / 255;
            const b = (hex & 255) / 255;
            let made = 0;
            for (let i = 0; i < SPARK_COUNT && made < count; i++) {
                if (sparkLife[i] > 0) continue;
                const j = i * 3;
                const ang = Math.random() * Math.PI * 2;
                const sp = 0.12 + Math.random() * 0.28;
                sparkPos[j] = x;
                sparkPos[j + 1] = y;
                sparkPos[j + 2] = z;
                sparkVel[j] = Math.cos(ang) * sp;
                sparkVel[j + 1] = 0.42 + Math.random() * 0.55;
                sparkVel[j + 2] = Math.sin(ang) * sp * 0.55;
                sparkCol[j] = r;
                sparkCol[j + 1] = g;
                sparkCol[j + 2] = b;
                sparkLife[i] = 0.30 + Math.random() * 0.16;
                made++;
            }
        }

        function updateSparks(dt) {
            if (!sparkPoints || !sparkLife) return;
            let any = false;
            const grav = 1.25;
            for (let i = 0; i < SPARK_COUNT; i++) {
                if (sparkLife[i] <= 0) continue;
                const j = i * 3;
                sparkLife[i] -= dt;
                if (sparkLife[i] <= 0) {
                    sparkCol[j] = 0;
                    sparkCol[j + 1] = 0;
                    sparkCol[j + 2] = 0;
                    continue;
                }
                any = true;
                sparkVel[j + 1] -= grav * dt;
                sparkPos[j] += sparkVel[j] * dt;
                sparkPos[j + 1] += sparkVel[j + 1] * dt;
                sparkPos[j + 2] += sparkVel[j + 2] * dt;
                const fade = 1 - Math.min(1, dt * 3.2);
                sparkCol[j] *= fade;
                sparkCol[j + 1] *= fade;
                sparkCol[j + 2] *= fade;
            }
            sparkPoints.geometry.attributes.position.needsUpdate = true;
            sparkPoints.geometry.attributes.color.needsUpdate = true;
            sparkPoints.visible = any;
        }

        function colorComponents(colorHex) {
            return {
                r: (colorHex >> 16) & 255,
                g: (colorHex >> 8) & 255,
                b: colorHex & 255,
            };
        }

        function scaledRgb(rgb, scale) {
            return {
                r: Math.max(0, Math.min(255, Math.round(rgb.r * scale))),
                g: Math.max(0, Math.min(255, Math.round(rgb.g * scale))),
                b: Math.max(0, Math.min(255, Math.round(rgb.b * scale))),
            };
        }

        function rgbCss(rgb) {
            return `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`;
        }

        /**
         * Create a subtle body gradient for note gems.
         *
         * The texture darkens toward local bottom-left so the gem reads as lit
         * from screen top-right without changing the note's source color.
         *
         * @param {number} colorHex - Note color.
         * @returns {object|null} Three.js texture, or null outside the browser.
         */
        function createNoteGradientTexture(colorHex) {
            if (typeof document === 'undefined' || !document.createElement || !T.CanvasTexture) return null;
            const c = document.createElement('canvas');
            c.width = 64;
            c.height = 64;
            const ctx = c.getContext('2d');
            if (!ctx) return null;
            const base = colorComponents(colorHex);
            const dark = scaledRgb(base, 0.26);
            const mid = scaledRgb(base, 0.7);
            const highlight = {
                r: Math.min(255, Math.round(base.r * 1.2 + 30)),
                g: Math.min(255, Math.round(base.g * 1.2 + 30)),
                b: Math.min(255, Math.round(base.b * 1.2 + 30)),
            };
            const grad = ctx.createLinearGradient(0, c.height, c.width, 0);
            grad.addColorStop(0, rgbCss(dark));
            grad.addColorStop(0.58, rgbCss(mid));
            grad.addColorStop(1, rgbCss(highlight));
            ctx.fillStyle = grad;
            ctx.fillRect(0, 0, c.width, c.height);

            const texture = new T.CanvasTexture(c);
            if (T.SRGBColorSpace) texture.colorSpace = T.SRGBColorSpace;
            texture.magFilter = T.LinearFilter;
            texture.minFilter = T.LinearFilter;
            texture.needsUpdate = true;
            return texture;
        }

        /**
         * Return a cached material for note meshes.
         *
         * @param {number} colorHex - Three.js hex color.
         * @param {string} variant - `normal` or `front`.
         * @returns {object} Three.js material.
         */
        function getNoteMaterial(colorHex, variant) {
            const type = variant === 'front' ? variant : 'normal';
            const key = String(colorHex) + ':' + type;
            if (noteMaterials.has(key)) return noteMaterials.get(key);
            const glow = 0.25 + (activeSettings.glowStrength || 0) * 0.75;
            const gradientMap = type === 'front' ? createNoteGradientTexture(colorHex) : null;
            let material;
            if (type === 'front') {
                material = new T.MeshBasicMaterial({
                    color: gradientMap ? 0xffffff : colorHex,
                    map: gradientMap || null,
                    transparent: true,
                    opacity: 0.98,
                    depthWrite: true,
                    side: T.DoubleSide,
                });
            } else {
                material = new T.MeshStandardMaterial({
                    color: colorHex,
                    emissive: colorHex,
                    emissiveIntensity: 0.06 * glow,
                    metalness: 0.12,
                    roughness: 0.5,
                    transparent: true,
                    opacity: 0.82,
                });
            }
            noteMaterials.set(key, material);
            return material;
        }

        function updateSettingsFromStorage() {
            const next = readSettings();
            const noteMaterialChanged = !activeSettings || next.glowStrength !== activeSettings.glowStrength;
            const cinematicChanged = !activeSettings || next.cinematicLighting !== activeSettings.cinematicLighting;
            const backgroundChanged = !activeSettings || next.backgroundStyle !== activeSettings.backgroundStyle || next.backgroundIntensity !== activeSettings.backgroundIntensity;
            activeSettings = next;
            if (labelGroup) labelGroup.visible = !!activeSettings.showLabels;
            if (camera) applyCameraSettings();
            if (cinematicChanged) applyCinematicLighting();
            if (backgroundChanged) buildBackground();
            if (noteMaterialChanged) disposeNoteMaterials();
            if (activeThemeId !== activeSettings.sceneTheme) {
                applySceneTheme();
            }
        }

        function themeColors() {
            return SCENE_THEMES[activeSettings.sceneTheme] || SCENE_THEMES.default;
        }

        function applySceneTheme() {
            if (!scene) return;
            activeThemeId = activeSettings.sceneTheme;
            const theme = themeColors();
            scene.background = new T.Color(theme.clear);
            if (scene.fog) scene.fog.color.setHex(theme.fog);
            if (floorMesh && floorMesh.material && floorMesh.material.color) floorMesh.material.color.setHex(theme.floor);
            if (renderer && renderer.setClearColor) renderer.setClearColor(theme.clear, 1);
            if (surfaceGroup) {
                for (const surface of Object.values(surfaces)) {
                    if (!surface.active) continue;
                    if (surface.kind === 'pad' && surface.baseEmissiveColor != null) {
                        applyPadTargetStyle(surface, surface.baseEmissiveColor);
                        continue;
                    }
                    if (surface.material && surface.material.color && surface.kind !== 'external-trigger-center' && surface.kind !== 'external-trigger-edge') {
                        surface.material.color.setHex(theme.pad);
                    }
                    if (surface.edgeMaterial && surface.edgeMaterial.color) surface.edgeMaterial.color.setHex(theme.edge);
                }
            }
        }

        function applyCameraSettings() {
            if (!camera) return;
            const a = activeSettings.cameraAngle;
            camera.position.set(CAMERA_PAN_X, GRID_CENTER_Y + CAMERA_PAN_Y + a * 0.35, 6.8 - a * 0.8);
            camera.lookAt(CAMERA_PAN_X, GRID_CENTER_Y + CAMERA_PAN_Y, -TUNNEL_DEPTH * 0.5);
            baseCameraY = camera.position.y;
        }

        /**
         * Create a texture-backed sprite label for a pad surface.
         *
         * @param {string} text - Short label text.
         * @param {number} width - Sprite width in world units.
         * @param {number} height - Sprite height in world units.
         * @returns {object|null} Three.js sprite, or null when canvas is unavailable.
         */
        function createLabelSprite(text, width, height) {
            if (typeof document === 'undefined' || !document.createElement) return null;
            const c = document.createElement('canvas');
            c.width = 256;
            c.height = 96;
            const ctx = c.getContext('2d');
            if (!ctx) return null;
            ctx.clearRect(0, 0, c.width, c.height);
            ctx.font = '700 36px system-ui, -apple-system, Segoe UI, sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.lineWidth = 6;
            ctx.strokeStyle = 'rgba(0, 0, 0, 0.82)';
            ctx.fillStyle = SCENE_COLORS.text;
            ctx.strokeText(String(text || '').slice(0, 8), c.width / 2, c.height / 2);
            ctx.fillText(String(text || '').slice(0, 8), c.width / 2, c.height / 2);
            const texture = new T.CanvasTexture(c);
            const material = new T.SpriteMaterial({
                map: texture,
                transparent: true,
                depthWrite: false,
            });
            const sprite = new T.Sprite(material);
            sprite.scale.set(width, height, 1);
            return sprite;
        }

        /**
         * Add receding tunnel guide lines behind one pad surface.
         *
         * @param {number} x - Surface center X.
         * @param {number} y - Surface center Y.
         * @param {number} w - Surface width.
         * @param {number} h - Surface height.
         * @param {object} group - Three.js group receiving the line segments.
         * @returns {void}
         */
        function addTunnelLines(x, y, w, h, group) {
            const front = [
                [x - w / 2, y - h / 2, 0.015],
                [x + w / 2, y - h / 2, 0.015],
                [x + w / 2, y + h / 2, 0.015],
                [x - w / 2, y + h / 2, 0.015],
            ];
            const backX = TUNNEL_BACK_X_OFFSET + x * TUNNEL_BACK_SCALE;
            const backY = GRID_CENTER_Y + TUNNEL_BACK_LIFT + (y - GRID_CENTER_Y) * TUNNEL_BACK_SCALE;
            const back = [
                [backX - w * TUNNEL_BACK_SCALE / 2, backY - h * TUNNEL_BACK_SCALE / 2, -TUNNEL_DEPTH],
                [backX + w * TUNNEL_BACK_SCALE / 2, backY - h * TUNNEL_BACK_SCALE / 2, -TUNNEL_DEPTH],
                [backX + w * TUNNEL_BACK_SCALE / 2, backY + h * TUNNEL_BACK_SCALE / 2, -TUNNEL_DEPTH],
                [backX - w * TUNNEL_BACK_SCALE / 2, backY + h * TUNNEL_BACK_SCALE / 2, -TUNNEL_DEPTH],
            ];
            const vertices = [];
            for (let i = 0; i < 4; i++) {
                const next = (i + 1) % 4;
                vertices.push(...front[i], ...back[i], ...back[i], ...back[next]);
            }
            const geo = new T.BufferGeometry();
            geo.setAttribute('position', new T.Float32BufferAttribute(vertices, 3));
            const mat = new T.LineBasicMaterial({
                color: SCENE_COLORS.tunnel,
                transparent: true,
                opacity: 0.38,
                depthWrite: false,
            });
            const lines = new T.LineSegments(geo, mat);
            // Keep well below note gems' renderOrder (10/11) and skip
            // writing depth, so these always draw behind incoming notes
            // instead of z-fighting/poking through them.
            lines.renderOrder = 1;
            group.add(lines);
        }

        /**
         * Add one rectangular render surface and edge outline to the surface group.
         *
         * @param {string} key - Surface id.
         * @param {number} x - Surface center X.
         * @param {number} y - Surface center Y.
         * @param {number} w - Surface width.
         * @param {number} h - Surface height.
         * @param {number} colorHex - Routed surface color.
         * @param {number} opacity - Base material opacity.
         * @param {object} group - Three.js group receiving the surface meshes.
         * @returns {object} Surface descriptor used by note placement.
         */
        function addPlaneSurface(key, x, y, w, h, colorHex, opacity, group) {
            const geo = makeRoundedSurfaceGeometry(w, h);
            const theme = themeColors();
            const mat = new T.MeshStandardMaterial({
                color: theme.pad,
                emissive: colorHex,
                emissiveIntensity: 0.05,
                metalness: 0.1,
                roughness: 0.72,
                side: T.DoubleSide,
                transparent: true,
                depthWrite: false,
                opacity,
            });
            const mesh = new T.Mesh(geo, mat);
            mesh.position.set(x, y, 0);
            group.add(mesh);

            const edgeGeo = makeRoundedSurfaceEdgeGeometry(w, h);
            const edgeMat = new T.LineBasicMaterial({
                color: theme.edge,
                transparent: true,
                opacity: 0.74,
            });
            const edges = new T.Line(edgeGeo, edgeMat);
            edges.position.copy(mesh.position);
            group.add(edges);

            return { key, x, y, w, h, mesh, material: mat, edgeMaterial: edgeMat, baseOpacity: opacity, baseEmissiveIntensity: 0.05 };
        }

        /**
         * Add one circular render surface and circular edge outline.
         *
         * @param {string} key - Surface id.
         * @param {number} x - Surface center X.
         * @param {number} y - Surface center Y.
         * @param {number} radius - Circle radius.
         * @param {number} colorHex - Fill/emissive color for the circle.
         * @param {number} opacity - Base material opacity.
         * @param {object} group - Three.js group receiving the surface meshes.
         * @returns {object} Surface descriptor used by note placement.
         */
        function addCircleSurface(key, x, y, radius, colorHex, opacity, group) {
            const geo = new T.CircleGeometry(radius, 48);
            const mat = new T.MeshStandardMaterial({
                color: colorHex,
                emissive: colorHex,
                emissiveIntensity: 0.12,
                metalness: 0.08,
                roughness: 0.58,
                side: T.DoubleSide,
                transparent: true,
                depthWrite: false,
                opacity,
            });
            const mesh = new T.Mesh(geo, mat);
            mesh.position.set(x, y, 0.018);
            group.add(mesh);

            const points = [];
            for (let i = 0; i <= 48; i++) {
                const theta = (i / 48) * Math.PI * 2;
                points.push(new T.Vector3(Math.cos(theta) * radius, Math.sin(theta) * radius, 0));
            }
            const edgeGeo = new T.BufferGeometry().setFromPoints(points);
            const edgeMat = new T.LineBasicMaterial({
                color: colorHex,
                transparent: true,
                opacity: 0.82,
            });
            const edges = new T.Line(edgeGeo, edgeMat);
            edges.position.copy(mesh.position);
            group.add(edges);

            const diameter = radius * 2;
            return {
                key,
                x,
                y,
                w: diameter,
                h: diameter,
                mesh,
                material: mat,
                edgeMaterial: edgeMat,
                baseOpacity: opacity,
                baseEmissiveColor: colorHex,
                baseEmissiveIntensity: 0.12,
            };
        }

        /**
         * Add one thick ring render surface for external trigger edge zones.
         *
         * @param {string} key - Surface id.
         * @param {number} x - Surface center X.
         * @param {number} y - Surface center Y.
         * @param {number} innerRadius - Inner radius of the ring.
         * @param {number} outerRadius - Outer radius of the ring.
         * @param {number} colorHex - Fill/emissive color for the ring.
         * @param {number} opacity - Base material opacity.
         * @param {object} group - Three.js group receiving the surface mesh.
         * @returns {object} Surface descriptor used by note placement.
         */
        function addRingSurface(key, x, y, innerRadius, outerRadius, colorHex, opacity, group) {
            const geo = new T.RingGeometry(innerRadius, outerRadius, 64);
            const mat = new T.MeshStandardMaterial({
                color: colorHex,
                emissive: colorHex,
                emissiveIntensity: 0.16,
                metalness: 0.08,
                roughness: 0.52,
                side: T.DoubleSide,
                transparent: true,
                depthWrite: false,
                opacity,
            });
            const mesh = new T.Mesh(geo, mat);
            mesh.position.set(x, y, 0.026);
            group.add(mesh);

            const diameter = outerRadius * 2;
            return {
                key,
                x,
                y,
                w: diameter,
                h: diameter,
                mesh,
                material: mat,
                baseOpacity: opacity,
                baseEmissiveColor: colorHex,
                baseEmissiveIntensity: 0.16,
            };
        }

        /**
         * Make a regular pad target read as a colored outline with a faint fill.
         *
         * @param {object} surface - Surface descriptor returned by addPlaneSurface.
         * @param {number} colorHex - Pad route color.
         * @returns {void}
         */
        function applyPadTargetStyle(surface, colorHex) {
            if (!surface) return;
            if (surface.material) {
                if (surface.material.color) surface.material.color.setHex(colorHex);
                if (surface.material.emissive) surface.material.emissive.setHex(colorHex);
                surface.material.emissiveIntensity = 0.04;
                surface.material.opacity = PAD_TARGET_FILL_OPACITY;
            }
            if (surface.edgeMaterial) {
                if (surface.edgeMaterial.color) surface.edgeMaterial.color.setHex(colorHex);
                surface.edgeMaterial.opacity = PAD_TARGET_EDGE_OPACITY;
            }
            surface.baseOpacity = PAD_TARGET_FILL_OPACITY;
            surface.baseEmissiveColor = colorHex;
            surface.baseEmissiveIntensity = 0.04;
        }

        /**
         * Rebuild the stable pad grid, labels, tunnels, and outline surfaces.
         *
         * @param {object} profile - Validated pad profile.
         * @returns {void}
         */
        function buildSurfaceGrid(profile, pedalProfile, triggerProfile) {
            if (surfaceGroup) {
                disposeObjectTree(surfaceGroup);
                removeFromParent(surfaceGroup);
            }
            if (labelGroup) {
                disposeObjectTree(labelGroup);
                removeFromParent(labelGroup);
            }
            surfaceGroup = new T.Group();
            labelGroup = new T.Group();
            labelGroup.visible = !!activeSettings.showLabels;
            (highwayGroup || scene).add(surfaceGroup);
            (highwayGroup || scene).add(labelGroup);
            surfaces = Object.create(null);
            const layout = buildSurfaceLayout(profile, pedalProfile, triggerProfile);
            activeSurfaceLayoutKey = layout.layoutKey;
            // Pad positions/count may have changed - the cached whole-group
            // outline geometry (see placeLayoutPreview) is stale.
            if (layoutPreviewGroupFrameGeometry) layoutPreviewGroupFrameGeometry.dispose();
            layoutPreviewGroupFrameGeometry = buildLayoutPreviewGroupFrameGeometry(layout.gridW, layout.gridH);
            // One guide-line frustum for the whole grid's bounding box - not
            // one per pad, which cluttered the highway with a line for every
            // single cell.
            addTunnelLines(0, GRID_CENTER_Y, layout.gridW, layout.gridH, surfaceGroup);

            for (const desc of layout.surfaces) {
                let surface;
                if (desc.shape === 'circle') {
                    surface = addCircleSurface(desc.key, desc.x, desc.y, desc.radius, desc.color, desc.opacity, surfaceGroup);
                } else if (desc.shape === 'ring') {
                    surface = addRingSurface(desc.key, desc.x, desc.y, desc.innerRadius, desc.outerRadius, desc.color, desc.opacity, surfaceGroup);
                } else {
                    surface = addPlaneSurface(desc.key, desc.x, desc.y, desc.w, desc.h, desc.color, desc.opacity, surfaceGroup);
                }
                surface.active = !!desc.active;
                if (!surface.active) {
                    if (surface.material && surface.material.color) surface.material.color.setHex(SCENE_COLORS.inactiveSurface);
                    if (surface.material && surface.material.emissive) surface.material.emissive.setHex(SCENE_COLORS.inactiveSurface);
                    if (surface.edgeMaterial && surface.edgeMaterial.color) surface.edgeMaterial.color.setHex(SCENE_COLORS.inactiveEdge);
                    if (surface.edgeMaterial) surface.edgeMaterial.opacity = 0.35;
                } else if (desc.kind === 'pad') {
                    applyPadTargetStyle(surface, desc.color);
                }
                if (surface.material && surface.material.emissive && typeof surface.material.emissive.getHex === 'function') {
                    surface.baseEmissiveColor = surface.material.emissive.getHex();
                }
                surface.kind = desc.kind;
                surfaces[surface.key] = surface;
                if (desc.kind === 'pad') {
                    const label = activeSettings.showLabels ? createLabelSprite(desc.pad.label || '—', PAD_W * 0.58, PAD_H * 0.26) : null;
                    if (label) {
                        label.position.set(desc.x, desc.y, 0.08);
                        labelGroup.add(label);
                    }
                }
            }
        }

        function buildBackground() {
            if (!scene) return;
            if (bgGroup) {
                disposeObjectTree(bgGroup);
                scene.remove(bgGroup);
            }
            bgGroup = new T.Group();
            bgGroup.renderOrder = -1;
            scene.add(bgGroup);
            bgState = null;
            const style = BACKGROUND_STYLE_SET.has(activeSettings.backgroundStyle) ? activeSettings.backgroundStyle : DEFAULT_SETTINGS.backgroundStyle;
            const intensity = clampNumber(activeSettings.backgroundIntensity, 0, 1, DEFAULT_SETTINGS.backgroundIntensity);
            activeBackgroundKey = style + ':' + intensity;
            if (style === 'off') return;

            if (style === 'particles') {
                const count = Math.max(20, Math.floor(80 + 200 * intensity));
                const positions = new Float32Array(count * 3);
                for (let i = 0; i < count; i++) {
                    positions[i * 3] = (Math.random() - 0.5) * 14;
                    positions[i * 3 + 1] = Math.random() * 5.8 - 0.4;
                    positions[i * 3 + 2] = -12 - Math.random() * 18;
                }
                const geo = new T.BufferGeometry();
                geo.setAttribute('position', new T.BufferAttribute(positions, 3).setUsage(T.DynamicDrawUsage));
                const mat = new T.PointsMaterial({
                    color: 0xa0c0ff,
                    size: 0.035,
                    transparent: true,
                    opacity: 0.58,
                    blending: T.AdditiveBlending,
                    depthWrite: false,
                    sizeAttenuation: true,
                });
                const points = new T.Points(geo, mat);
                points.frustumCulled = false;
                points.renderOrder = -1;
                bgGroup.add(points);
                bgState = { style, points, geo, mat, count };
                return;
            }

            if (style === 'lights') {
                const lights = [];
                const count = Math.floor(6 + 8 * intensity);
                for (let i = 0; i < count; i++) {
                    const geo = new T.PlaneGeometry(0.22, 0.22);
                    const mat = new T.MeshBasicMaterial({
                        color: DEFAULT_PALETTE[i % DEFAULT_PALETTE.length],
                        transparent: true,
                        opacity: 0.55,
                        blending: T.AdditiveBlending,
                        depthWrite: false,
                    });
                    const mesh = new T.Mesh(geo, mat);
                    mesh.renderOrder = -1;
                    mesh.position.set((Math.random() - 0.5) * 11, Math.random() * 4.8 + 0.2, -13 - Math.random() * 17);
                    bgGroup.add(mesh);
                    lights.push({ mesh, geo, mat, baseScale: 1 + Math.random() * 0.5, phase: Math.random() * Math.PI * 2 });
                }
                bgState = { style, lights };
                return;
            }

            if (style === 'geometric') {
                const meshes = [];
                const opacity = 0.45 + 0.25 * intensity;
                const ico = new T.Mesh(
                    new T.IcosahedronGeometry(0.65, 1),
                    new T.MeshBasicMaterial({ color: 0x6080c0, wireframe: true, transparent: true, opacity, depthWrite: false })
                );
                ico.position.set(-3.0, 3.5, -18);
                ico.renderOrder = -1;
                bgGroup.add(ico);
                meshes.push(ico);

                const torus = new T.Mesh(
                    new T.TorusGeometry(0.48, 0.08, 6, 12),
                    new T.MeshBasicMaterial({ color: 0xc06080, wireframe: true, transparent: true, opacity: opacity * 0.9, depthWrite: false })
                );
                torus.position.set(3.2, 2.7, -20);
                torus.renderOrder = -1;
                bgGroup.add(torus);
                meshes.push(torus);
                bgState = { style, meshes };
            }
        }

        function updateBackground(dt, t) {
            const style = BACKGROUND_STYLE_SET.has(activeSettings.backgroundStyle) ? activeSettings.backgroundStyle : DEFAULT_SETTINGS.backgroundStyle;
            const intensity = clampNumber(activeSettings.backgroundIntensity, 0, 1, DEFAULT_SETTINGS.backgroundIntensity);
            const key = style + ':' + intensity;
            if (key !== activeBackgroundKey) buildBackground();
            if (!bgState) return;
            if (bgState.style === 'particles') {
                const positions = bgState.geo.attributes.position.array;
                const dx = dt * 0.10;
                for (let i = 0; i < bgState.count; i++) {
                    positions[i * 3] += dx;
                    if (positions[i * 3] > 7) positions[i * 3] -= 14;
                }
                bgState.geo.attributes.position.needsUpdate = true;
                bgState.mat.opacity = 0.46 + Math.sin(t * 0.75) * 0.08;
            } else if (bgState.style === 'lights') {
                for (const light of bgState.lights) {
                    const pulse = 1 + Math.sin(t * 1.5 + light.phase) * 0.2;
                    light.mesh.scale.set(light.baseScale * pulse, light.baseScale * pulse, 1);
                    light.mat.opacity = 0.55 + Math.sin(t * 1.1 + light.phase) * 0.12;
                }
            } else if (bgState.style === 'geometric') {
                const pulse = 1 + Math.sin(t * 1.2) * 0.08;
                for (const mesh of bgState.meshes) {
                    mesh.rotation.x += dt * 0.06;
                    mesh.rotation.y += dt * 0.08;
                    mesh.scale.setScalar(pulse);
                }
            }
        }

        function applyCinematicLighting() {
            if (ambientLight) ambientLight.intensity = activeSettings.cinematicLighting ? 0.30 : 0.40;
            if (keyLight) keyLight.intensity = activeSettings.cinematicLighting ? 1.20 : 1.00;
        }

        /**
         * Create the base Three.js scene, camera, lights, floor, and surface grid.
         *
         * @returns {void}
         */
        function initScene() {
            scene = new T.Scene();
            activeSettings = readSettings();
            activeThemeId = activeSettings.sceneTheme;
            const theme = themeColors();
            scene.background = new T.Color(theme.clear);
            scene.fog = new T.Fog(theme.fog, 12, 34);
            camera = new T.PerspectiveCamera(54, 1, 0.1, 90);
            applyCameraSettings();

            ambientLight = new T.AmbientLight(0x7c8ca8, 0.40);
            keyLight = new T.DirectionalLight(0xffffff, 1.00);
            keyLight.position.set(-3, 6, 5);
            const rim = new T.DirectionalLight(0x67e8f9, 0.65);
            rim.position.set(3, 3, -6);
            scene.add(ambientLight, keyLight, rim);
            applyCinematicLighting();
            buildBackground();

            floorMesh = new T.Mesh(
                new T.PlaneGeometry(20, 42),
                new T.MeshStandardMaterial({
                    color: theme.floor,
                    roughness: 0.85,
                    metalness: 0.06,
                })
            );
            floorMesh.rotation.x = -Math.PI / 2;
            floorMesh.position.set(0, FLOOR_Y, -9);
            scene.add(floorMesh);

            sparkPos = new Float32Array(SPARK_COUNT * 3);
            sparkCol = new Float32Array(SPARK_COUNT * 3);
            sparkVel = new Float32Array(SPARK_COUNT * 3);
            sparkLife = new Float32Array(SPARK_COUNT);
            const sparkGeo = new T.BufferGeometry();
            sparkGeo.setAttribute('position', new T.BufferAttribute(sparkPos, 3).setUsage(T.DynamicDrawUsage));
            sparkGeo.setAttribute('color', new T.BufferAttribute(sparkCol, 3).setUsage(T.DynamicDrawUsage));
            const sparkMat = new T.PointsMaterial({
                size: 0.035,
                vertexColors: true,
                transparent: true,
                opacity: 0.8,
                depthWrite: false,
                blending: T.AdditiveBlending,
                sizeAttenuation: true,
            });
            sparkPoints = new T.Points(sparkGeo, sparkMat);
            sparkPoints.frustumCulled = false;
            sparkPoints.renderOrder = 8;
            sparkPoints.visible = false;
            scene.add(sparkPoints);

            highwayGroup = new T.Group();
            applyHighwayTransform();
            scene.add(highwayGroup);

            notesGroup = new T.Group();
            highwayGroup.add(notesGroup);
            layoutPreviewGroup = new T.Group();
            highwayGroup.add(layoutPreviewGroup);
            noteGeometry = makeRoundedNoteGeometry();
            noteFaceGeometry = makeRoundedNoteFaceGeometry();
            const profile = readMultipadProfile();
            buildSurfaceGrid(profile.padProfile, profile.pedalProfile, profile.triggerProfile);
        }

        /**
         * Apply canvas size, device pixel ratio, and camera aspect.
         *
         * @param {number} w - CSS width from the host.
         * @param {number} h - CSS height from the host.
         * @returns {void}
         */
        function applySize(w, h) {
            if (!renderer || !camera || !canvas) return;
            const W = Math.max(1, Math.round(w || canvas.clientWidth || canvas.width || 1));
            const H = Math.max(1, Math.round(h || canvas.clientHeight || canvas.height || 1));
            const split = liveInstances.size > 1;
            const baseDpr = split
                ? Math.min(window.devicePixelRatio || 1, 1.25)
                : Math.min(window.devicePixelRatio || 1, 2);
            renderer.setPixelRatio(baseDpr * renderScale);
            renderer.setSize(W, H, false);
            camera.aspect = W / H;
            camera.updateProjectionMatrix();
            lastWidth = W;
            lastHeight = H;
        }

        /**
         * Return projected hit events for the current bundle.
         *
         * The real chart projection is cached by drum-tab object identity and
         * hit count. The host streams drum hits by mutating `drumTab.hits` in
         * chunks, so object identity alone can leave the renderer stuck on the
         * first partial chunk of a real feedpak.
         *
         * @param {object|null} bundle - Host render bundle.
         * @returns {object|null} Projection returned by `projectDrumTab`.
         */
        function rememberProjection(projection) {
            lastProjectionStats = projection && projection.stats ? projection.stats : null;
            if (!lastProjectionStats || lastProjectionStats.rawHits <= 0 || lastProjectionStats.projectedHits > 0) return;
            const warningKey = [
                lastProjectionStats.source,
                lastProjectionStats.rawHits,
                settingsVersion,
                countMapKeys(lastProjectionStats.unknownPieces),
                countMapKeys(lastProjectionStats.unroutedPieces),
            ].join('|');
            if (warningKey === lastZeroProjectionWarningKey) return;
            lastZeroProjectionWarningKey = warningKey;
            console.warn('[Multipad-Hwy3D] projected zero notes from drum chart', lastProjectionStats);
        }

        function projectionForBundle(bundle) {
            const source = chartSourceFromBundle(bundle);
            if (source.type === 'drumTab') {
                if (!projectionCacheMatchesSource(source, {
                    sourceType: cachedProjectionSource,
                    drumTab: cachedDrumTab,
                    hitCount: cachedDrumHitCount,
                    settingsVersion: cachedSettingsVersion,
                })) {
                    const settings = readSettings();
                    const profile = readMultipadProfile();
                    cachedProjectionSource = source.type;
                    cachedDrumTab = source.drumTab;
                    cachedDrumHitCount = source.hitCount;
                    cachedSettingsVersion = settingsVersion;
                    cachedProjection = projectDrumTab(source.drumTab, {
                        padProfile: profile.padProfile,
                        pedalProfile: profile.pedalProfile,
                        triggerProfile: profile.triggerProfile,
                        hitGroupWindowSec: settings.hitGroupWindowMs / 1000,
                        source: source.type,
                    });
                    buildSurfaceGrid(cachedProjection.padProfile, cachedProjection.pedalProfile, cachedProjection.triggerProfile);
                    rememberProjection(cachedProjection);
                }
                return cachedProjection;
            }
            cachedProjectionSource = '';
            cachedDrumTab = null;
            cachedDrumHitCount = -1;
            cachedProjection = null;
            lastProjectionStats = null;
            cachedSettingsVersion = settingsVersion;
            return null;
        }

        /**
         * Restore surface materials and scales before rendering the current frame.
         *
         * @returns {void}
         */
        function resetSurfaceState() {
            for (const id of Object.keys(surfaces)) {
                const surface = surfaces[id];
                if (surface.material.emissive && surface.baseEmissiveColor != null) {
                    surface.material.emissive.setHex(surface.baseEmissiveColor);
                }
                surface.material.emissiveIntensity = surface.baseEmissiveIntensity;
                surface.material.opacity = surface.baseOpacity;
                surface.mesh.scale.set(1, 1, 1);
            }
        }

        /**
         * Resolve the render surface descriptor for a projected event.
         *
         * @param {object} event - Projected hit event.
         * @returns {object|null} Surface descriptor.
         */
        function surfaceForEvent(event) {
            return event && event.surfaceId ? (surfaces[event.surfaceId] || null) : null;
        }

        /**
         * Recompute how many seconds of lookahead NOTE_AHEAD_BEATS currently
         * represents, from the chart's local tempo around the current
         * playhead, and the depth a note now spawns at (NOTE_SPEED times
         * that). Uses the two bundle beats bracketing `t` so tempo changes
         * are picked up as playback passes through them, rather than a
         * single fixed BPM for the whole song. Falls back to
         * NOTE_AHEAD_FALLBACK_SEC when there's no usable beat grid (fewer
         * than 2 beats).
         *
         * @param {object|null} bundle - Host render bundle.
         * @param {number} t - Current chart time.
         * @returns {void}
         */
        function updateNoteAheadFromTempo(bundle, t) {
            const beats = bundle && Array.isArray(bundle.beats) ? bundle.beats : null;
            let secPerBeat = null;
            if (beats && beats.length >= 2) {
                const i = lowerBoundTimeField(beats, t);
                const hi = Math.min(beats.length - 1, Math.max(1, i));
                const lo = hi - 1;
                const interval = beats[hi].time - beats[lo].time;
                if (Number.isFinite(interval) && interval > 0) secPerBeat = interval;
            }
            activeNoteAheadSec = secPerBeat != null ? NOTE_AHEAD_BEATS * secPerBeat : NOTE_AHEAD_FALLBACK_SEC;
            activeNoteSpawnDepth = Math.max(0.001, activeNoteAheadSec * NOTE_SPEED);
        }

        /**
         * Return the first real-chart event index that can affect this frame.
         *
         * @param {object} projection - Current chart projection.
         * @param {number} t - Current chart time.
         * @returns {number} Start index for visible-event scanning.
         */
        function visibleEventStartIndex(projection, t) {
            const events = projection && projection.hitEvents ? projection.hitEvents : [];
            const minTime = t - NOTE_BEHIND_SEC;
            const mustRebase = renderCursorProjection !== projection
                || t < renderCursorTime
                || Math.abs(t - renderCursorTime) > RENDER_CURSOR_REBASE_SEC;
            if (mustRebase) {
                renderCursorProjection = projection;
                renderCursorIndex = lowerBoundHitEvents(events, minTime);
            } else {
                while (renderCursorIndex < events.length && events[renderCursorIndex].t < minTime) {
                    renderCursorIndex++;
                }
            }
            renderCursorTime = t;
            return renderCursorIndex;
        }

        /**
         * Draw a faint white outline of the whole pad grid's bounding box
         * traveling alongside an approaching note, so the hit group reads as
         * one unit as it moves down the highway. Uses the exact same
         * back-projection transform as the note's own position (anchored at
         * the grid's own center), so its center travels in step with the
         * note gem itself. Drawn at full (unscaled) size throughout - see
         * the "no separate size-shrink" comment in placeNote for why - so
         * only camera perspective, not an extra world-space scale curve,
         * makes it read as smaller while still far away.
         *
         * @param {number} z - Current depth, matching the note's own z.
         * @param {number} scaleProgress - Current clamped travel progress, matching the note's own.
         * @param {number} fadeInFactor - Spawn fade-in multiplier in [0, 1], matching the note's own.
         * @returns {void}
         */
        function placeLayoutPreview(z, scaleProgress, fadeInFactor) {
            if (!layoutPreviewGroup || !layoutPreviewGroupFrameGeometry) return;
            // The outline's own local offset from the grid center is
            // (0, 0) - it IS the grid center, at full (unscaled) size.
            const center = projectGridPoint(0, 0, scaleProgress);
            const group = acquireLayoutPreviewGroupMesh();
            group.mesh.position.set(center.x, center.y, z);
            group.mesh.scale.set(1, 1, 1);
            // Fade out as the note approaches - fully transparent by the
            // time it reaches the target, rather than staying at a flat
            // opacity all the way in - and fade in from spawn (see
            // placeNote) rather than popping in at full opacity.
            group.mesh.material.opacity = LAYOUT_PREVIEW_GROUP_OPACITY * (1 - scaleProgress) * fadeInFactor;
        }

        /**
         * Add a visible note mesh for one event at a time offset from the hit plane.
         *
         * @param {object} event - Projected hit event.
         * @param {number} dt - Seconds until hit time; positive means upstream.
         * @returns {void}
         */
        function placeNote(event, dt) {
            const surface = surfaceForEvent(event);
            if (!surface || !noteGeometry || !noteFaceGeometry || !notesGroup) return;
            // No hit detection exists yet (post-MVP), so every note is
            // effectively "unhandled" - keep it moving through the target at
            // the same speed instead of freezing it at the threshold. `z` is
            // allowed to go positive (past the hit plane, toward the camera)
            // once dt goes negative. Position keeps extrapolating along the
            // exact same back-point-to-target line it was already traveling
            // (positionProgress is not clamped above 1) instead of freezing
            // laterally and only pushing forward in z - that used to create a
            // visible kink in the travel direction right at the threshold.
            // Size still caps at the target's own dimensions once past
            // threshold (scaleProgress stays clamped to 1). Normalized
            // against activeNoteSpawnDepth (tempo-derived, see
            // updateNoteAheadFromTempo), not the fixed TUNNEL_DEPTH used
            // only for the cosmetic guide-line wireframe, so a note always
            // spawns at exactly progress=0 regardless of the chart's tempo.
            const z = -dt * NOTE_SPEED;
            const rawProgress = (z + activeNoteSpawnDepth) / activeNoteSpawnDepth;
            const positionProgress = Math.max(0, rawProgress);
            const scaleProgress = Math.min(1, positionProgress);
            // Same projectGridPoint the outline uses for its own center
            // (see that function's comment) - a pad's own offset from the
            // grid's center (surface.x, surface.y - GRID_CENTER_Y) is real
            // and constant, never separately compressed toward the
            // vanishing point.
            const point = projectGridPoint(surface.x, surface.y - GRID_CENTER_Y, positionProgress);
            const x = point.x;
            const y = point.y;
            const isPastThreshold = dt <= 0;
            const color = isPastThreshold ? NOTE_PAST_THRESHOLD_COLOR : eventColorForEvent(event);
            const note = acquireNoteMesh(
                getNoteMaterial(color, 'normal'),
                getNoteMaterial(color, 'front')
            );
            // No separate size-shrink curve: gems are always drawn at their
            // real target dimensions (surface.w/h), for every progress value
            // - not scaled up from a smaller spawn size. Two earlier passes
            // tried a world-space size curve tied to progress (first an
            // eased 43-68%-start curve, then TUNNEL_BACK_SCALE-based, then a
            // cubic-eased version of that) to keep distant gems from
            // overlapping their neighbors or the layout-preview outline -
            // but every version of "shrink size AND shrink position both as
            // functions of progress" compounds with the camera's own real
            // perspective divide, which already does the "looks smaller
            // when farther away" job on its own. Removing the extra curve
            // simplifies the highway back to one source of size truth (the
            // pad's real dimensions) and lets ordinary perspective account
            // for distance - at the cost of legitimately dense, evenly-timed
            // hit streams still crowding near spawn, same as any highway.
            const w = surface.w;
            const h = surface.h;
            const bodyH = Math.max(0.045, h);
            // With no size ramp to visually mark "just spawned," gems now
            // fade in from fully transparent instead - elapsedSinceSpawn is
            // how long this note has been visible (activeNoteAheadSec is
            // this frame's tempo-derived total flight time, dt counts down
            // from it to 0), clamped into a 0..1 ramp over
            // NOTE_SPAWN_FADE_SEC. Past-threshold notes are always long past
            // this window (dt <= 0 implies elapsed >= activeNoteAheadSec >>
            // NOTE_SPAWN_FADE_SEC), so it's a no-op there.
            const elapsedSinceSpawn = activeNoteAheadSec - dt;
            const fadeInFactor = Math.min(1, Math.max(0, elapsedSinceSpawn / NOTE_SPAWN_FADE_SEC));
            // Repeat dimming is a pad-grid-pattern cue (see PLANNING.md) -
            // pedal/trigger gems always render at full opacity regardless of
            // their own repeatedFromPreviousGroup value.
            const isRepeat = event.type === 'pad' && !!event.repeatedFromPreviousGroup;
            note.group.position.set(x, y, z);
            note.body.scale.set(w, bodyH, 0.11);
            note.face.scale.set(w, bodyH, 1);
            if (isPastThreshold) {
                // Snap straight to the dim, near-invisible state the instant
                // a note crosses the threshold - no gradual fade down from a
                // brighter starting point. A fade window here meant the gem
                // stayed noticeably visible (and, combined with continuing
                // to grow via perspective, noticeably large) for a
                // perceptible stretch right after crossing.
                note.body.material.opacity = NOTE_PAST_THRESHOLD_OPACITY * fadeInFactor;
                note.face.material.opacity = NOTE_PAST_THRESHOLD_OPACITY * fadeInFactor;
            } else {
                note.body.material.opacity = (isRepeat ? 0.24 : 0.82) * fadeInFactor;
                note.face.material.opacity = (isRepeat ? 0.2 : 0.98) * fadeInFactor;
                if (!isRepeat && surface.kind === 'pad') {
                    placeLayoutPreview(z, scaleProgress, fadeInFactor);
                }
            }
        }

        /**
         * Return a point on a surface's border for a fraction `u` of the way
         * around it, so spark origins can be spread evenly around the whole
         * target instead of clustering at one spot.
         *
         * Rectangular surfaces are walked clockwise from the top-left corner,
         * proportional to each edge's length, so points are evenly spaced by
         * arc length rather than by corner count. Circular/ring surfaces walk
         * their radius instead.
         *
         * @param {object} surface - Surface descriptor (x, y, w, h, shape, radius).
         * @param {number} u - Fraction around the border, in [0, 1).
         * @returns {{x: number, y: number}} Border point in scene units.
         */
        function surfaceBorderPoint(surface, u) {
            if (surface.shape === 'circle' || surface.shape === 'ring') {
                const r = surface.radius || surface.w * 0.5;
                const ang = u * Math.PI * 2;
                return { x: surface.x + Math.cos(ang) * r, y: surface.y + Math.sin(ang) * r };
            }
            const w = surface.w;
            const h = surface.h;
            const halfW = w * 0.5;
            const halfH = h * 0.5;
            const perimeter = Math.max(0.0001, 2 * (w + h));
            let d = u * perimeter;
            if (d < w) return { x: surface.x - halfW + d, y: surface.y + halfH };
            d -= w;
            if (d < h) return { x: surface.x + halfW, y: surface.y + halfH - d };
            d -= h;
            if (d < w) return { x: surface.x + halfW - d, y: surface.y - halfH };
            d -= w;
            return { x: surface.x - halfW, y: surface.y - halfH + d };
        }

        /**
         * Spawn spark bursts spread evenly around a surface's whole border.
         *
         * @param {object} surface - Surface descriptor.
         * @param {number} hex - Spark color.
         * @param {number} totalCount - Total spark particles across all origins.
         * @returns {void}
         */
        function sparkBorderBurst(surface, hex, totalCount) {
            const origins = 8;
            const perOrigin = Math.max(1, Math.round(totalCount / origins));
            for (let i = 0; i < origins; i++) {
                const p = surfaceBorderPoint(surface, i / origins);
                sparkBurst(p.x, p.y, 0.08, hex, perOrigin);
            }
        }

        function crossingFxKey(event, cycleBase) {
            return [
                cycleBase || 0,
                event && event.t,
                event && event.surfaceId,
                event && event.piece,
            ].join(':');
        }

        function triggerEventFx(event) {
            const surface = surfaceForEvent(event);
            if (!surface || !surface.active) return;
            const color = timingHex(event);
            const intensity = activeSettings.feedbackIntensity || 0;
            if (intensity <= 0) return;
            const sparkCount = Math.max(6, Math.round(10 + 10 * intensity));
            const isKick = event.piece === 'kick' || event.surfaceId === 'outline-bottom';
            if (isKick) kickPulse = Math.max(kickPulse, 1);
            sparkBorderBurst(surface, isKick ? KICK_COLOR : color, isKick ? sparkCount * 3 : sparkCount);
        }

        function maybeTriggerCrossingFx(event, dt, cycleBase) {
            if (dt > 0 || dt < -NOTE_BEHIND_SEC) return;
            const key = crossingFxKey(event, cycleBase);
            if (crossedEventFxKeys.has(key)) return;
            crossedEventFxKeys.add(key);
            triggerEventFx(event);
        }

        /**
         * Rebuild visible note meshes and crossing effects for the current frame.
         *
         * @param {object|null} bundle - Host render bundle.
         * @returns {void}
         */
        function renderEvents(bundle) {
            if (!notesGroup) return;
            clearTransientNotes();
            clearTransientLayoutPreviews();
            const projection = projectionForBundle(bundle);
            resetSurfaceState();
            if (!projection) return;

            const t = Number.isFinite(bundle && bundle.currentTime)
                ? bundle.currentTime
                : 0;
            updateNoteAheadFromTempo(bundle, t);
            const events = projection.hitEvents;
            if (crossingFxProjection !== projection || t < crossingFxTime - 0.05 || Math.abs(t - crossingFxTime) > RENDER_CURSOR_REBASE_SEC) {
                crossedEventFxKeys = new Set();
                crossingFxProjection = projection;
            }
            crossingFxTime = t;
            const startIndex = visibleEventStartIndex(projection, t);
            for (let i = startIndex; i < events.length; i++) {
                const event = events[i];
                const dt = event.t - t;
                if (dt > activeNoteAheadSec) break;
                if (dt < -NOTE_BEHIND_SEC) continue;
                placeNote(event, dt);
                maybeTriggerCrossingFx(event, dt, 0);
            }
        }

        function updateWallClockFx() {
            const nowMs = typeof performance !== 'undefined' && performance && typeof performance.now === 'function'
                ? performance.now()
                : Date.now();
            const dt = fxLastWall === 0 ? 1 / 60 : Math.min(0.05, (nowMs - fxLastWall) / 1000);
            fxLastWall = nowMs;
            updateSparks(dt);
            updateBackground(dt, nowMs / 1000);
            const intensity = activeSettings.feedbackIntensity || 0;
            if (kickPulse > 0.001 && camera) {
                kickPulse *= Math.exp(-dt * KICK_SHAKE_DECAY);
                camera.position.y = baseCameraY - KICK_SHAKE_MAGNITUDE * kickPulse * intensity;
            } else if (kickPulse !== 0) {
                kickPulse = 0;
                if (camera) camera.position.y = baseCameraY;
            }
        }

        /**
         * Dispose renderer-owned resources and clear instance state.
         *
         * @returns {void}
         */
        function teardown() {
            ready = false;
            clearTransientNotes();
            if (scene) disposeObjectTree(scene);
            if (renderer) renderer.dispose();
            disposeNoteMaterials();
            // Never entered the scene graph (only its .clone()s did), so
            // disposeObjectTree(scene) above never reaches it either.
            if (layoutPreviewGroupMaterial && typeof layoutPreviewGroupMaterial.dispose === 'function') {
                layoutPreviewGroupMaterial.dispose();
            }
            canvas = null;
            lastBundle = null;
            scene = null;
            camera = null;
            renderer = null;
            highwayGroup = null;
            surfaceGroup = null;
            notesGroup = null;
            layoutPreviewGroup = null;
            layoutPreviewGroupFrameGeometry = null;
            layoutPreviewGroupMaterial = null;
            layoutPreviewGroupMeshPool = [];
            visibleLayoutPreviewGroupCount = 0;
            labelGroup = null;
            surfaces = Object.create(null);
            noteGeometry = null;
            noteFaceGeometry = null;
            floorMesh = null;
            ambientLight = null;
            keyLight = null;
            bgGroup = null;
            bgState = null;
            activeBackgroundKey = '';
            crossedEventFxKeys = new Set();
            crossingFxProjection = null;
            crossingFxTime = -Infinity;
            sparkPoints = null;
            sparkPos = null;
            sparkCol = null;
            sparkVel = null;
            sparkLife = null;
            fxLastWall = 0;
            kickPulse = 0;
            baseCameraY = 0;
            noteMeshPool = [];
            cachedDrumTab = null;
            cachedDrumHitCount = -1;
            cachedProjectionSource = '';
            cachedProjection = null;
            lastProjectionStats = null;
            lastZeroProjectionWarningKey = '';
            renderCursorProjection = null;
            renderCursorIndex = 0;
            renderCursorTime = -Infinity;
            activeNoteAheadSec = NOTE_AHEAD_FALLBACK_SEC;
            activeNoteSpawnDepth = NOTE_AHEAD_FALLBACK_SEC * NOTE_SPEED;
            activeSurfaceLayoutKey = null;
            visibleNoteCount = 0;
        }

        const instance = {
            contextType: CONTEXT_TYPE,

            init(nextCanvas, bundle) {
                if (renderer || scene) teardown();
                const initGeneration = ++generation;
                canvas = nextCanvas || null;
                lastBundle = bundle || null;
                destroyed = false;
                ready = false;
                liveInstances.add(instance);
                if (!canvas) return;

                loadThree().then(() => {
                    if (destroyed || initGeneration !== generation || !canvas) return;
                    try {
                        renderer = new T.WebGLRenderer({
                            canvas,
                            antialias: true,
                            alpha: false,
                            powerPreference: 'high-performance',
                        });
                        renderer.setClearColor(SCENE_COLORS.clear, 1);
                        initScene();
                        applySize(canvas.clientWidth || canvas.width || lastWidth, canvas.clientHeight || canvas.height || lastHeight);
                    } catch (err) {
                        // initScene used to run outside this try/catch, so an
                        // exception there (bad pad-profile geometry, etc.)
                        // fell through to the outer .catch below, which
                        // teardown()s silently with no console output - a
                        // real scene-build bug then looked exactly like "the
                        // canvas never rendered anything," with no error
                        // logged anywhere to point at why.
                        console.error('[Multipad-Hwy3D] scene init failed:', err);
                        teardown();
                        return;
                    }
                    ready = true;
                    instance.draw(lastBundle);
                }).catch(err => {
                    console.error('[Multipad-Hwy3D] Three.js load failed:', err);
                    if (!destroyed) teardown();
                });
            },

            draw(bundle) {
                if (destroyed) return;
                lastBundle = bundle || lastBundle;
                if (!ready || !renderer || !scene || !camera) return;
                updateSettingsFromStorage();
                const nextScale = (lastBundle && Number.isFinite(lastBundle.renderScale)) ? lastBundle.renderScale : 1;
                if (nextScale !== renderScale) {
                    renderScale = nextScale;
                    applySize(canvas && canvas.clientWidth, canvas && canvas.clientHeight);
                }
                if (canvas) {
                    const w = canvas.clientWidth || canvas.width || lastWidth;
                    const h = canvas.clientHeight || canvas.height || lastHeight;
                    if (w && h && (Math.abs(w - lastWidth) > 1 || Math.abs(h - lastHeight) > 1)) {
                        applySize(w, h);
                    }
                }
                renderEvents(lastBundle);
                updateWallClockFx();
                renderer.render(scene, camera);
            },

            resize(width, height) {
                lastWidth = Number.isFinite(width) ? Math.max(0, width) : 0;
                lastHeight = Number.isFinite(height) ? Math.max(0, height) : 0;
                if (ready) applySize(lastWidth, lastHeight);
            },

            destroy() {
                liveInstances.delete(instance);
                destroyed = true;
                generation++;
                teardown();
                lastWidth = 0;
                lastHeight = 0;
            },

            __probe() {
                return {
                    pluginId: PLUGIN_ID,
                    contextType: CONTEXT_TYPE,
                    initialized: !!canvas && !destroyed,
                    ready,
                    width: lastWidth,
                    height: lastHeight,
                    hasBundle: !!lastBundle,
                    surfaces: Object.keys(surfaces).length,
                    drumTabPresent: !!(lastBundle && lastBundle.drumTab),
                    drumTabHits: hasDrumTabHitStream(lastBundle && lastBundle.drumTab) ? lastBundle.drumTab.hits.length : 0,
                    projectionSource: cachedProjectionSource,
                    projectedHits: cachedProjection ? cachedProjection.hitEvents.length : 0,
                    projectionStats: lastProjectionStats,
                    profileId: lastProjectionStats ? lastProjectionStats.profileId : activeSettings.profileId,
                    padProfileId: lastProjectionStats ? lastProjectionStats.padProfileId : activeSettings.padProfileId,
                    pedalProfileId: lastProjectionStats ? lastProjectionStats.pedalProfileId : activeSettings.pedalProfileId,
                    triggerProfileId: lastProjectionStats ? lastProjectionStats.triggerProfileId : activeSettings.triggerProfileId,
                    visibleNotes: visibleNoteCount,
                    showLabels: !!activeSettings.showLabels,
                    cameraAngle: activeSettings.cameraAngle,
                    sceneTheme: activeSettings.sceneTheme,
                    feedbackIntensity: activeSettings.feedbackIntensity,
                    timingColors: activeSettings.timingColors,
                    hitSparks: activeSettings.hitSparks,
                    cinematicLighting: activeSettings.cinematicLighting,
                    backgroundStyle: activeSettings.backgroundStyle,
                    backgroundIntensity: activeSettings.backgroundIntensity,
                };
            },
        };

        return instance;
    }

