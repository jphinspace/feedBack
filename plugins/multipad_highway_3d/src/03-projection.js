    // ---------------------------------------------------------------------
    // Chart Source Selection
    // ---------------------------------------------------------------------

    function hasDrumTabHitStream(drumTab) {
        return !!(drumTab && Array.isArray(drumTab.hits));
    }

    function chartSourceFromBundle(bundle) {
        const drumTab = bundle && bundle.drumTab;
        if (!hasDrumTabHitStream(drumTab)) {
            return {
                type: 'none',
                drumTab: null,
                hitCount: -1,
            };
        }
        return {
            type: 'drumTab',
            drumTab,
            hitCount: drumTab.hits.length,
        };
    }

    function projectionCacheMatchesSource(source, cache) {
        return !!(
            source
            && cache
            && cache.sourceType === source.type
            && cache.drumTab === source.drumTab
            && cache.hitCount === source.hitCount
            && cache.settingsVersion === settingsVersion
        );
    }

    // ---------------------------------------------------------------------
    // Projection Diagnostics
    // ---------------------------------------------------------------------

    function incrementCount(map, key) {
        if (!key) return;
        map[key] = (map[key] || 0) + 1;
    }

    function countMapKeys(map) {
        return map && typeof map === 'object' ? Object.keys(map).length : 0;
    }

    function routePieceCount(routeMap) {
        return routeMap && typeof routeMap === 'object' ? Object.keys(routeMap).length : 0;
    }

    function projectionStats(source, rawHits, padProfile, pedalProfile, triggerProfile, pieceToPad, pieceToPedal, pieceToTrigger) {
        return {
            source,
            rawHits,
            normalizedHits: 0,
            projectedHits: 0,
            invalidHits: 0,
            unknownPieces: Object.create(null),
            unroutedPieces: Object.create(null),
            projectedPieces: Object.create(null),
            profileId: padProfile.id,
            padProfileId: padProfile.id,
            pedalProfileId: pedalProfile.id,
            triggerProfileId: triggerProfile.id,
            routedPadPieces: routePieceCount(pieceToPad),
            routedPedalPieces: routePieceCount(pieceToPedal),
            routedTriggerPieces: routePieceCount(pieceToTrigger),
        };
    }

    // ---------------------------------------------------------------------
    // Piece-To-Surface Routing
    // ---------------------------------------------------------------------

    /**
     * Build piece -> pad routing for a pad profile.
     *
     * The returned route preserves the original piece and separately
     * records the fallback `routedPiece`, so rendering can keep labels/variants
     * honest while sharing a pad for pieces such as open/closed hi-hat.
     *
     * @param {object} padProfile - Validated or raw pad profile.
     * @returns {object} Map of piece id to { routeType, pad, routedPiece }.
     */
    function buildPieceToPadMap(padProfile) {
        const profile = validatePadProfile(padProfile) || clonePadProfile(DEFAULT_PAD_PROFILE);
        const direct = Object.create(null);
        for (const pad of profile.pads) {
            for (const piece of pad.pieces) {
                direct[piece] = { routeType: 'pad', pad };
            }
        }

        const routed = Object.create(null);
        for (const piece of PAD_PIECES) {
            if (direct[piece]) {
                routed[piece] = Object.assign({ routedPiece: piece }, direct[piece]);
                continue;
            }
            const fallback = profile.fallbacks[piece] || PIECE_FALLBACKS[piece];
            if (fallback && direct[fallback]) {
                routed[piece] = Object.assign({ routedPiece: fallback }, direct[fallback]);
            }
        }
        return routed;
    }

    /**
     * Build piece -> external trigger surface routing for a trigger profile.
     *
     * @param {object} triggerProfile - Validated or raw trigger profile.
     * @returns {object} Map of piece id to trigger descriptor.
     */
    function buildPieceToTriggerMap(triggerProfile) {
        const profile = validateTriggerProfile(triggerProfile) || cloneTriggerProfile(DEFAULT_TRIGGER_PROFILE);
        const routed = Object.create(null);
        for (const trigger of profile.triggers) {
            for (const piece of trigger.pieces) {
                if (!routed[piece]) routed[piece] = trigger;
            }
        }
        return routed;
    }

    /**
     * Build piece -> pedal surface routing for a pedal profile.
     *
     * @param {object} pedalProfile - Validated or raw pedal profile.
     * @returns {object} Map of piece id to pedal descriptor.
     */
    function buildPieceToPedalMap(pedalProfile) {
        const profile = validatePedalProfile(pedalProfile) || clonePedalProfile(DEFAULT_PEDAL_PROFILE);
        const routed = Object.create(null);
        for (const pedal of profile.pedals) {
            for (const piece of pedal.pieces) {
                if (!routed[piece]) routed[piece] = pedal;
            }
        }
        return routed;
    }

    // ---------------------------------------------------------------------
    // Drum Hit Projection
    // ---------------------------------------------------------------------

    /**
     * Multipad intentionally ignores drum articulations/cues for MVP visuals.
     * The source piece still routes normally, but every scheduled event renders
     * as a plain hit on the corresponding pad or outline surface.
     *
     * @returns {'normal'}
     */
    function hitVariant(hit) {
        void hit;
        return 'normal';
    }

    /**
     * Normalize one `bundle.drumTab.hits[]` entry.
     *
     * Invalid or unknown future pieces return null. Velocity is clamped, and
     * open hi-hat remains a distinct piece even if it later routes to the same
     * pad, trigger, or fallback route as closed hi-hat.
     *
     * @param {*} hit - Raw drum-tab hit.
     * @returns {object|null}
     */
    function normalizeHit(hit) {
        if (!hit || typeof hit !== 'object') return null;
        const t = Number(hit.t);
        const piece = hit.p;
        if (!Number.isFinite(t) || typeof piece !== 'string' || !PIECE_SET.has(piece)) return null;
        const velocity = Math.round(clampNumber(hit.v, 0, 127, 100));
        return {
            t,
            piece,
            velocity,
            ghost: !!hit.g,
            flam: !!hit.f,
            variant: hitVariant({ p: piece, v: velocity, g: !!hit.g, f: !!hit.f }),
            open: piece === 'hh_open',
            timingStatus: normalizeTimingStatus(hit.timingStatus || hit.timing || hit.ts),
        };
    }

    /**
     * Group hit events that occur in the same timing window.
     *
     * A hit group can include multiple pads, external triggers, and pedal
     * surfaces. Hit events are annotated with `hitGroupId` for render-time FX.
     *
     * @param {Array<object>} hitEvents - Projected hit events.
     * @param {number} windowSec - Same-time tolerance in seconds.
     * @returns {Array<object>}
     */
    function groupHitEvents(hitEvents, windowSec) {
        const sorted = hitEvents.slice().sort((a, b) => a.t - b.t || a.piece.localeCompare(b.piece));
        const groups = [];
        const tolerance = Math.max(0, Number(windowSec) || 0);
        for (const hitEvent of sorted) {
            let group = groups.length ? groups[groups.length - 1] : null;
            if (!group || Math.abs(hitEvent.t - group.t) > tolerance) {
                group = {
                    id: groups.length,
                    t: hitEvent.t,
                    hitEvents: [],
                    padIds: [],
                    triggerIds: [],
                    triggerSurfaces: [],
                    pedalSurfaces: [],
                    hasKick: false,
                    hasHiHatPedal: false,
                };
                groups.push(group);
            }
            hitEvent.hitGroupId = group.id;
            group.hitEvents.push(hitEvent);
            if (hitEvent.type === 'pedal') {
                if (hitEvent.piece === 'kick') group.hasKick = true;
                if (hitEvent.piece === 'hh_pedal') group.hasHiHatPedal = true;
                if (hitEvent.surfaceId && !group.pedalSurfaces.includes(hitEvent.surfaceId)) {
                    group.pedalSurfaces.push(hitEvent.surfaceId);
                }
            }
            if (hitEvent.type === 'pad' && !group.padIds.includes(hitEvent.padId)) {
                group.padIds.push(hitEvent.padId);
            }
            if (hitEvent.type === 'trigger' && !group.triggerIds.includes(hitEvent.triggerId)) {
                group.triggerIds.push(hitEvent.triggerId);
            }
            if (hitEvent.type === 'trigger' && hitEvent.surfaceId && !group.triggerSurfaces.includes(hitEvent.surfaceId)) {
                group.triggerSurfaces.push(hitEvent.surfaceId);
            }
        }
        // A hit event counts as a repeat of the immediately previous group
        // when its own surface was also present in that previous group -
        // per surface, not per whole-group composition. A steady repeating
        // hi-hat stays marked "repeat" even the moment another piece (e.g. a
        // snare) joins it or drops back out alongside it, since the hi-hat's
        // own surface is what's being asked about, not whether every other
        // surface in the group also happened to match. (An earlier revision
        // required the *whole* surface set to match exactly, so any change
        // to the group's composition reset every member to "not repeat" -
        // that read as over-eager: a joining/leaving second piece shouldn't
        // interrupt an otherwise-continuing pattern on the first piece.)
        //
        // This is also why there's no separate pad-only variant of this flag
        // for the layout-preview outline to gate on: pad surface ids
        // (`pad:<id>`) are never shared with pedal/trigger surface ids, so
        // for a pad-type event, "was my surface in the previous group's full
        // surface set" and "...in the previous group's pad-only subset" are
        // the same question with the same answer. A per-surface check
        // doesn't need pedal-blindness the way the old whole-set check did -
        // a pedal joining/leaving never touched a pad's own membership check
        // in the first place.
        let previousSurfaces = new Set();
        for (const group of groups) {
            const currentSurfaces = new Set();
            for (const hitEvent of group.hitEvents) {
                if (!hitEvent.surfaceId) continue;
                hitEvent.repeatedFromPreviousGroup = previousSurfaces.has(hitEvent.surfaceId);
                currentSurfaces.add(hitEvent.surfaceId);
            }
            previousSurfaces = currentSurfaces;
        }
        return groups;
    }

    /**
     * Project a drum tab into multipad hit events.
     *
     * This is the Phase 3 bridge from host chart data to renderer-ready data:
     * hits become pad, external-trigger, or pedal surface events, sorted by
     * time and grouped for simultaneous-hit FX. It does no DOM/WebGL work.
     *
     * @param {object} drumTab - Bundle drum tab object with a `hits` array.
     * @param {object} [options]
     * @param {object} [options.padProfile] - Optional pad profile.
     * @param {object} [options.pedalProfile] - Optional pedal profile.
     * @param {object} [options.triggerProfile] - Optional external trigger profile.
     * @param {number} [options.hitGroupWindowSec] - Grouping tolerance.
     * @param {string} [options.source] - Data source label for diagnostics.
     * @returns {{padProfile: object, pedalProfile: object, triggerProfile: object, hitEvents: Array<object>, hitGroups: Array<object>, stats: object}}
     */
    function projectDrumTab(drumTab, options) {
        const opts = options && typeof options === 'object' ? options : {};
        const padProfile = validatePadProfile(opts.padProfile) || clonePadProfile(DEFAULT_PAD_PROFILE);
        const pedalProfile = validatePedalProfile(opts.pedalProfile) || clonePedalProfile(DEFAULT_PEDAL_PROFILE);
        const triggerProfile = validateTriggerProfile(opts.triggerProfile) || cloneTriggerProfile(DEFAULT_TRIGGER_PROFILE);
        const pieceToPad = buildPieceToPadMap(padProfile);
        const pieceToPedal = buildPieceToPedalMap(pedalProfile);
        const pieceToTrigger = buildPieceToTriggerMap(triggerProfile);
        const hitGroupWindowSec = clampNumber(
            opts.hitGroupWindowSec,
            0,
            0.05,
            DEFAULT_SETTINGS.hitGroupWindowMs / 1000
        );
        const hits = drumTab && Array.isArray(drumTab.hits) ? drumTab.hits : [];
        const hitEvents = [];
        const stats = projectionStats(
            opts.source || 'drumTab',
            hits.length,
            padProfile,
            pedalProfile,
            triggerProfile,
            pieceToPad,
            pieceToPedal,
            pieceToTrigger
        );
        function recordEvent(event) {
            hitEvents.push(event);
            stats.projectedHits++;
            incrementCount(stats.projectedPieces, event.piece);
        }

        for (const rawHit of hits) {
            const hit = normalizeHit(rawHit);
            if (!hit) {
                const piece = rawHit && rawHit.p;
                if (typeof piece === 'string' && piece && !PIECE_SET.has(piece)) {
                    incrementCount(stats.unknownPieces, piece);
                } else {
                    stats.invalidHits++;
                }
                continue;
            }
            stats.normalizedHits++;
            const pedal = pieceToPedal[hit.piece];
            if (pedal) {
                recordEvent({
                    type: 'pedal',
                    pedalId: pedal.id,
                    surfaceId: pedal.surface,
                    label: PIECE_LABELS[hit.piece] || pedal.label,
                    pedalLabel: pedal.label,
                    color: pedal.color,
                    t: hit.t,
                    piece: hit.piece,
                    routedPiece: hit.piece,
                    velocity: hit.velocity,
                    variant: hit.variant,
                    open: false,
                    timingStatus: hit.timingStatus,
                });
                continue;
            }
            const trigger = pieceToTrigger[hit.piece];
            if (trigger) {
                recordEvent({
                    type: 'trigger',
                    triggerId: trigger.id,
                    surfaceId: trigger.surface,
                    label: PIECE_LABELS[hit.piece] || trigger.label,
                    triggerLabel: trigger.label,
                    color: trigger.color,
                    t: hit.t,
                    piece: hit.piece,
                    routedPiece: hit.piece,
                    velocity: hit.velocity,
                    variant: hit.variant,
                    open: hit.open,
                    timingStatus: hit.timingStatus,
                });
                continue;
            }
            const route = pieceToPad[hit.piece];
            if (!route) {
                incrementCount(stats.unroutedPieces, hit.piece);
                continue;
            }
            recordEvent({
                type: 'pad',
                padId: route.pad.id,
                surfaceId: 'pad:' + route.pad.id,
                row: route.pad.row,
                col: route.pad.col,
                label: PIECE_LABELS[hit.piece] || route.pad.label,
                padLabel: route.pad.label,
                t: hit.t,
                piece: hit.piece,
                routedPiece: route.routedPiece,
                velocity: hit.velocity,
                variant: hit.variant,
                open: hit.open,
                timingStatus: hit.timingStatus,
            });
        }

        hitEvents.sort((a, b) => a.t - b.t || a.piece.localeCompare(b.piece));
        const hitGroups = groupHitEvents(hitEvents, hitGroupWindowSec);
        return {
            padProfile,
            pedalProfile,
            triggerProfile,
            hitEvents,
            hitGroups,
            stats,
        };
    }

    /**
     * Auto-mode predicate for the visualization picker.
     *
     * Multipad Highway is a standalone, opt-in drum visualization. When it is
     * installed, Auto mode may choose it for drum/percussion charts even if the
     * standard drum highway is also available. It still must not claim guitar,
     * bass, combo, or keys arrangements from full-band packs.
     *
     * @param {object} songInfo - Host song/arrangement metadata.
     * @returns {boolean}
     */
    function matchesArrangement(songInfo) {
        if (!songInfo || !songInfo.has_drum_tab) return false;
        const arr = songInfo.arrangement || songInfo.arrangement_smart_name || '';
        return /\b(?:drums?|percussion)\b/i.test(arr);
    }

