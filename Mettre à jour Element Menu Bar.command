#!/bin/bash
# Copyright 2026 o-Oby
# SPDX-License-Identifier: AGPL-3.0-only
# Please see LICENSE files in the repository root for full details.

set -uo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
REPOSITORY_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$REPOSITORY_DIR" || exit 1
printf '\nElement Menu Bar — préparation d’une version personnalisée\n\n'
if NODE_BINARY="$(bash scripts/menubar/bootstrap.sh --node-path)"; then
    "$NODE_BINARY" scripts/menubar/update.ts
    RESULT=$?
else
    RESULT=1
    printf '\nImpossible de préparer les outils de compilation.\n' >&2
fi
if [ -t 0 ]; then
    printf '\nAppuyez sur Entrée pour fermer cette fenêtre…'
    read -r _
fi
exit "$RESULT"
