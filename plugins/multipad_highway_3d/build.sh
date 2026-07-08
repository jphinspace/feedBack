#!/usr/bin/env bash
# Regenerate screen.js by concatenating src/*.js in order.
#
# screen.js is what feedBack's plugin loader actually serves and executes as
# one <script> tag (plugin.json's "script" field) — that contract doesn't
# change. This script only changes how the plugin is *authored*: instead of
# hand-editing one ~3000-line file, edit the numbered file under src/ that
# matches the section you're touching, then rebuild.
#
# The generated screen.js is committed, so Docker/desktop builds and the
# plugin loader never run this — same convention as build-tailwind.sh at the
# repo root. Run it whenever you edit src/*.js, and commit the regenerated
# screen.js in the same commit. CI's multipad-h3d-js-fresh job fails the
# build if you forget.
set -euo pipefail
cd "$(dirname "$0")"

{
    cat <<'HEADER'
// Multipad Highway 3D visualization plugin.
//
// GENERATED FILE — do not edit directly. Edit the numbered source file
// under src/ that matches the section you're touching, then run
// ./build.sh to regenerate this file. Source layout mirrors the plugin
// loader's single-script contract (plugin.json's "script" field still
// points at this one file):
//   src/01-constants.js    constants and drum vocabulary
//   src/02-profiles.js     profile/settings validation
//   src/03-projection.js   chart source and projection helpers
//   src/04-renderer.js     Three.js renderer lifecycle
//   src/05-api.js          test and settings-panel APIs
//   src/06-player-ui.js    player-controls toggle button

(function () {
    'use strict';

HEADER
    cat src/01-constants.js
    cat src/02-profiles.js
    cat src/03-projection.js
    cat src/04-renderer.js
    cat src/05-api.js
    cat src/06-player-ui.js
    printf '})();\n'
} > screen.js
