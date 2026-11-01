/*
Copyright 2026 o-Oby

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE-AGPL-3.0 in the repository root for full details.
*/

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const requireDesktop = createRequire(path.join(root, "apps/desktop/package.json"));
const asar = requireDesktop("@electron/asar") as { extractFile(archive: string, file: string): Buffer };
const dist = path.join(root, "apps/desktop/dist");
const app = path.join(dist, "mac-arm64/Element Menu Bar.app");
const resources = path.join(app, "Contents/Resources");
const metadata = JSON.parse(asar.extractFile(path.join(resources, "app.asar"), "package.json").toString());
const config = JSON.parse(asar.extractFile(path.join(resources, "webapp.asar"), "config.json").toString());
const webVersion = asar.extractFile(path.join(resources, "webapp.asar"), "version").toString().trim();
const release = JSON.parse(fs.readFileSync(path.join(root, "menubar/release.json"), "utf8"));
assert.equal(metadata.productName, "Element Menu Bar");
assert.equal(metadata.name, "element-menubar");
assert.equal(metadata.electron_appId, "io.github.o-oby.element-menubar");
assert.equal(metadata.electron_protocol, "io.github.o-oby.element-menubar");
assert.equal(metadata.electron_manual_updates, true);
assert.equal(metadata.version, release.upstreamTag.slice(1));
assert.equal(webVersion, metadata.version);
assert.equal(config.brand, "Element Menu Bar");
assert.equal(config.update_base_url, undefined);
for (const image of ["menubarTemplate.png", "menubarTemplate@2x.png"]) {
    assert.ok(fs.statSync(path.join(resources, "build", image)).size > 0);
}
const bundleId = execFileSync(
    "/usr/libexec/PlistBuddy",
    ["-c", "Print :CFBundleIdentifier", path.join(app, "Contents/Info.plist")],
    { encoding: "utf8" },
).trim();
assert.equal(bundleId, metadata.electron_appId);
execFileSync("codesign", ["--verify", "--deep", "--strict", app], { stdio: "inherit" });
const dmgName = `Element-Menu-Bar-${metadata.version}-r${release.revision}-arm64.dmg`;
const dmg = path.join(dist, dmgName);
assert.ok(fs.statSync(dmg).size > 0);
execFileSync("hdiutil", ["verify", dmg], { stdio: "inherit" });
const digest = execFileSync("shasum", ["-a", "256", dmg], { encoding: "utf8" }).split(/\s+/)[0];
fs.writeFileSync(`${dmg}.sha256`, `${digest}  ${dmgName}\n`);
console.log("Identité, mises à jour manuelles, ressources, versions, signature et DMG vérifiés.");
