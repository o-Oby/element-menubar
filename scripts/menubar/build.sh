#!/bin/bash
# Copyright 2026 o-Oby
# SPDX-License-Identifier: AGPL-3.0-only
# Build and verify the personal macOS arm64 application from a versioned checkout.
set -euo pipefail
repo_dir="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$repo_dir"
source "$repo_dir/scripts/menubar/bootstrap.sh"
menubar_bootstrap

# node-gyp cannot build native modules in a path containing spaces.
if [[ "$repo_dir" == *" "* ]]; then
    if [[ -n "$(git status --porcelain --untracked-files=normal)" ]]; then
        echo "Enregistrez les modifications Git avant de construire depuis ce dossier." >&2
        exit 1
    fi
    build_dir="$(mktemp -d /private/tmp/element-menubar-build.XXXXXX)"
    echo "Compilation isolée : $build_dir"
    git archive HEAD | tar -x -C "$build_dir"
    if ! bash "$build_dir/scripts/menubar/build.sh"; then
        echo "Échec : sources et journaux de compilation conservés dans $build_dir" >&2
        exit 1
    fi
    mkdir -p "$repo_dir/apps/desktop/dist"
    ditto "$build_dir/apps/desktop/dist" "$repo_dir/apps/desktop/dist"
    rm -rf "$build_dir"
    exit 0
fi

command -v gpg >/dev/null || { echo "GnuPG est nécessaire (brew install gnupg)." >&2; exit 1; }
xcode-select -p >/dev/null
release_version="$(node -p 'JSON.parse(require("fs").readFileSync("menubar/release.json", "utf8")).upstreamTag.slice(1)')"
revision="$(node -p 'JSON.parse(require("fs").readFileSync("menubar/release.json", "utf8")).revision')"
package_version="$(node -p 'JSON.parse(require("fs").readFileSync("apps/desktop/package.json", "utf8")).version')"
if [[ ! "$release_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ || "$release_version" != "$package_version" || ! "$revision" =~ ^[1-9][0-9]*$ ]]; then
    echo "Les versions Web/Desktop et la révision du fork ne correspondent pas." >&2
    exit 1
fi
export VERSION="$release_version"
export MENUBAR_REVISION="$revision"
export VARIANT_PATH="$repo_dir/menubar/build.json"
export CSC_IDENTITY_AUTO_DISCOVERY=false
# Personal builds must not pick up signing or notarization credentials from the shell.
unset CSC_LINK CSC_KEY_PASSWORD APPLE_TEAM_ID APPLE_ID APPLE_APP_SPECIFIC_PASSWORD

pnpm install --filter 'element-desktop...' --frozen-lockfile
# The upstream dependency policy omits Electron's binary install hook.
node apps/desktop/node_modules/electron/install.js
pnpm --dir apps/desktop lint:types
pnpm --dir apps/desktop exec vitest run --config vitest.config.ts
node --test scripts/menubar/update.test.ts

cache_dir="${ELEMENT_MENUBAR_CACHE_DIR:-$HOME/Library/Caches/ElementMenuBar}"
mkdir -p "$cache_dir/packages"
prepare_dir="$(mktemp -d /private/tmp/element-menubar-web.XXXXXX)"
export GNUPGHOME="$prepare_dir/gnupg"
mkdir -m 700 "$GNUPGHOME"
fingerprint="$(gpg --batch --show-keys --with-colons scripts/menubar/element-release-key.asc | awk -F: '$1 == "fpr" { print $10; exit }')"
if [[ "$fingerprint" != 712BFBEE92DCA45252DB17D7C7BE97EFA179B100 ]]; then
    echo "Empreinte de la clé de publication Element inattendue." >&2
    exit 1
fi
gpg --batch --import scripts/menubar/element-release-key.asc
mkdir -p "$prepare_dir/config" "$prepare_dir/deploys"
node --input-type=module - "$prepare_dir/config/config.json" <<'NODE'
import fs from "node:fs";
const config = JSON.parse(fs.readFileSync("apps/desktop/element.io/release/config.json", "utf8"));
delete config.update_base_url;
const variant = JSON.parse(fs.readFileSync("menubar/build.json", "utf8"));
config.brand = variant.productName;
fs.writeFileSync(process.argv[2], JSON.stringify(config, null, 4) + "\n");
NODE
(cd apps/desktop && pnpm run fetch --packages "$cache_dir/packages" --deploys "$prepare_dir/deploys" --cfgdir "$prepare_dir/config")
# Explicit build commands avoid Nx reusing a package produced for another variant.
pnpm --dir apps/desktop exec tsc
(cd apps/desktop && node scripts/copy-res.ts)
pnpm --dir apps/desktop exec playwright test playwright/e2e/launch/menubar.spec.ts --retries=0 --reporter=line
pnpm --dir apps/desktop exec electron-builder --mac dmg --arm64 --publish never
node scripts/menubar/verify-build.ts
rm -rf "$prepare_dir"
echo "Livraison vérifiée : $repo_dir/apps/desktop/dist"
