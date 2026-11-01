#!/bin/bash
# Copyright 2026 o-Oby
# SPDX-License-Identifier: AGPL-3.0-only
# Install isolated, upstream-pinned tools without changing the system Node or pnpm.
set -euo pipefail

menubar_bootstrap() {
    local repo_dir node_version cache_dir node_dir archive temp_dir expected actual pnpm_version pnpm_dir lock_dir waited
    repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
    node_version="$(tr -d '[:space:]' < "$repo_dir/apps/desktop/.node-version")"
    if [[ ! "$node_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
        echo "Version Node non épinglée : $node_version" >&2
        return 1
    fi
    if [[ "$(uname -s)" != Darwin || "$(uname -m)" != arm64 ]]; then
        echo "Cette livraison nécessite un Mac Apple Silicon." >&2
        return 1
    fi
    cache_dir="${ELEMENT_MENUBAR_CACHE_DIR:-$HOME/Library/Caches/ElementMenuBar}/toolchains"
    mkdir -p "$cache_dir"
    node_dir="$cache_dir/node-$node_version"
    lock_dir="$cache_dir/bootstrap.lock"
    waited=0
    until mkdir "$lock_dir" 2>/dev/null; do
        if [[ "$waited" -ge 120 ]]; then
            echo "Une préparation des outils est déjà en cours. Consultez $lock_dir/pid." >&2
            return 1
        fi
        sleep 1
        waited=$((waited + 1))
    done
    (
    trap 'rm -f "$lock_dir/pid"; rmdir "$lock_dir"' EXIT
    printf '%s\n' "$$" > "$lock_dir/pid"
    if [[ ! -x "$node_dir/bin/node" ]]; then
        echo "Préparation de Node ${node_version}…" >&2
        temp_dir="$(mktemp -d "$cache_dir/node-download.XXXXXX")"
        archive="node-v$node_version-darwin-arm64.tar.gz"
        curl --fail --location --retry 3 --silent --show-error "https://nodejs.org/dist/v$node_version/$archive" -o "$temp_dir/$archive"
        curl --fail --location --retry 3 --silent --show-error "https://nodejs.org/dist/v$node_version/SHASUMS256.txt" -o "$temp_dir/SHASUMS256.txt"
        expected="$(awk -v filename="$archive" '$2 == filename { print $1 }' "$temp_dir/SHASUMS256.txt")"
        actual="$(shasum -a 256 "$temp_dir/$archive" | awk '{print $1}')"
        if [[ ${#expected} != 64 || "$actual" != "$expected" ]]; then
            echo "La vérification du téléchargement Node a échoué : $temp_dir" >&2
            return 1
        fi
        tar -xzf "$temp_dir/$archive" -C "$temp_dir"
        if [[ ! -d "$node_dir" ]]; then mv "$temp_dir/node-v$node_version-darwin-arm64" "$node_dir"; fi
        rm -rf "$temp_dir"
    fi
    export PATH="$node_dir/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
    pnpm_version="$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).devEngines.packageManager.version' "$repo_dir/package.json")"
    if [[ ! "$pnpm_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
        echo "Version pnpm non épinglée : $pnpm_version" >&2
        return 1
    fi
    pnpm_dir="$cache_dir/pnpm-$pnpm_version"
    if [[ ! -x "$pnpm_dir/node_modules/.bin/pnpm" ]]; then
        echo "Préparation de pnpm ${pnpm_version}…" >&2
        npm install --prefix "$pnpm_dir" --ignore-scripts --no-audit --no-fund "pnpm@$pnpm_version" >&2
    fi
    )
    export PATH="$node_dir/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
    pnpm_version="$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).devEngines.packageManager.version' "$repo_dir/package.json")"
    pnpm_dir="$cache_dir/pnpm-$pnpm_version"
    export PATH="$pnpm_dir/node_modules/.bin:$PATH"
    export ELEMENT_MENUBAR_NODE="$node_dir/bin/node"
    export NX_DAEMON=false
    export NX_SKIP_NX_CACHE=true
    export NX_NO_CLOUD=true
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
    menubar_bootstrap
    case "${1:-}" in
        --node-path) printf '%s\n' "$ELEMENT_MENUBAR_NODE" ;;
        "") node --version; pnpm --version ;;
        *) echo "Usage : bootstrap.sh [--node-path]" >&2; exit 2 ;;
    esac
fi
