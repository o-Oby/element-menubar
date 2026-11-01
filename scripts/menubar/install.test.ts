/*
Copyright 2026 o-Oby

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { installDelivery, treeDigest, type InstallOptions } from "./install.ts";

const cleanups: string[] = [];

function fixture(): {
    options: InstallOptions;
    delivery: string;
    source: string;
    events: string[];
    backups: () => string[];
    run: () => Promise<void>;
} {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "element-install-test-"));
    cleanups.push(root);
    const app = path.join(root, "Applications/Element.app");
    const source = path.join(root, "source/Element.app");
    const profile = path.join(root, "Application Support/Element");
    const delivery = path.join(root, "delivery");
    for (const directory of [app, source, profile, delivery]) fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(app, "binary"), "old app");
    fs.writeFileSync(path.join(source, "binary"), "new app");
    fs.symlinkSync("binary", path.join(app, "link"));
    fs.symlinkSync("binary", path.join(source, "link"));
    fs.writeFileSync(path.join(profile, "encrypted-database"), "private existing session");
    const name = "Element-Menu-Bar-1.2.3-r2-arm64.dmg";
    const image = "fixture image";
    fs.writeFileSync(path.join(delivery, name), image);
    fs.writeFileSync(
        path.join(delivery, "release.json"),
        JSON.stringify({
            upstreamTag: "v1.2.3",
            revision: 2,
            sourceCommit: "a".repeat(40),
            artifacts: [{ name, sha256: createHash("sha256").update(image).digest("hex") }],
        }),
    );
    const events: string[] = [];
    let running = true;
    const copy = (from: string, to: string): void => fs.cpSync(from, to, { recursive: true, verbatimSymlinks: true });
    const options: InstallOptions = {
        app,
        profile,
        backupRoot: path.join(root, "private backups"),
        log: () => {},
        host: {
            preflight: () => {
                events.push("preflight");
            },
            stage: (_dmg, destination) => {
                events.push("stage");
                copy(source, destination);
            },
            verify: (target) => {
                assert.ok(fs.existsSync(path.join(target, "binary")));
            },
            copy: (from, to) => {
                events.push("backup");
                assert.equal(running, false);
                copy(from, to);
            },
            quit: async () => {
                events.push("quit");
                running = false;
            },
            assertStopped: () => {
                if (running) throw new Error("still running");
            },
            launch: async () => {
                events.push("proton");
                running = true;
            },
        },
    };
    const backups = (): string[] =>
        fs.existsSync(options.backupRoot)
            ? fs.readdirSync(options.backupRoot).map((entry) => path.join(options.backupRoot, entry))
            : [];
    return { options, delivery, source, events, backups, run: () => installDelivery(delivery, options) };
}

afterEach(() => {
    for (const directory of cleanups.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

void describe("Element installation transaction", () => {
    void it("should back up the closed app and profile, replace only the app and relaunch via Proton", async () => {
        const f = fixture();
        const appBefore = treeDigest(f.options.app);
        const profileBefore = treeDigest(f.options.profile);
        await f.run();
        assert.deepEqual(f.events, ["preflight", "stage", "quit", "backup", "backup", "proton"]);
        assert.equal(treeDigest(f.options.app), treeDigest(f.source));
        assert.equal(treeDigest(f.options.profile), profileBefore);
        const [backup] = f.backups();
        assert.equal(treeDigest(path.join(backup, "Element.app")), appBefore);
        assert.equal(treeDigest(path.join(backup, "profile-Element")), profileBefore);
        assert.equal(fs.statSync(backup).mode & 0o777, 0o700);
        assert.equal(
            JSON.parse(fs.readFileSync(path.join(backup, "installation.json"), "utf8")).status,
            "launched-via-proton",
        );
        assert.deepEqual(fs.readdirSync(path.dirname(f.options.app)), ["Element.app"]);
        f.events.length = 0;
        await f.run();
        assert.deepEqual(f.events, ["preflight", "stage", "proton"]);
        assert.equal(f.backups().length, 1);
    });

    void it("should reject corrupt deliveries and invalid bundles before quitting", async () => {
        const f = fixture();
        fs.appendFileSync(path.join(f.delivery, "Element-Menu-Bar-1.2.3-r2-arm64.dmg"), "corrupt");
        await assert.rejects(f.run(), /empreinte/);
        assert.deepEqual(f.events, ["preflight"]);
        const second = fixture();
        second.options.host.verify = () => {
            throw new Error("wrong identity");
        };
        await assert.rejects(second.run(), /wrong identity/);
        assert.deepEqual(second.events, ["preflight", "stage"]);
    });

    void it("should stop when graceful quit is refused without backing up or changing the app", async () => {
        const f = fixture();
        const before = treeDigest(f.options.app);
        f.options.host.quit = async () => {
            throw new Error("quit refused");
        };
        await assert.rejects(f.run(), /quit refused/);
        assert.equal(treeDigest(f.options.app), before);
        assert.equal(f.backups().length, 0);
    });

    void it("should stop if backup contents differ or the profile changes while copying", async () => {
        for (const mutateOriginal of [false, true]) {
            const f = fixture();
            const before = treeDigest(f.options.app);
            const original = f.options.host.copy;
            f.options.host.copy = (from, to) => {
                original(from, to);
                if (from === f.options.profile)
                    fs.writeFileSync(path.join(mutateOriginal ? from : to, "encrypted-database"), "changed");
            };
            await assert.rejects(f.run(), /sauvegarde ne correspond/);
            assert.equal(treeDigest(f.options.app), before);
            assert.ok(!f.events.includes("proton"));
        }
    });

    void it("should preserve the original error when writing the failure diagnostic also fails", async () => {
        const f = fixture();
        const before = treeDigest(f.options.app);
        f.options.host.copy = () => {
            const diagnostic = path.join(f.backups()[0], "installation.json");
            fs.unlinkSync(diagnostic);
            fs.mkdirSync(diagnostic);
            throw new Error("backup disk failure");
        };
        await assert.rejects(f.run(), /backup disk failure[\s\S]*diagnostic n’a pas pu être écrit[\s\S]*Sauvegarde/);
        assert.equal(treeDigest(f.options.app), before);
        assert.ok(!f.events.includes("proton"));
    });

    void it("should stop if Element reappears during the backup", async () => {
        const f = fixture();
        const before = treeDigest(f.options.app);
        let checks = 0;
        f.options.host.assertStopped = () => {
            if (++checks === 2) throw new Error("reopened");
        };
        await assert.rejects(f.run(), /reopened/);
        assert.equal(treeDigest(f.options.app), before);
        assert.ok(!f.events.includes("proton"));
    });

    void it("should restore the original when the second rename or installed verification fails", async () => {
        for (const removeStaged of [false, true]) {
            const f = fixture();
            const before = treeDigest(f.options.app);
            let staged = "";
            const original = f.options.host.verify;
            f.options.host.verify = (app, version) => {
                original(app, version);
                if (version && app !== f.options.app) staged = app;
                if (removeStaged && app.startsWith(f.options.backupRoot)) fs.rmSync(staged, { recursive: true });
                if (!removeStaged && version && app === f.options.app) throw new Error("bad installed signature");
            };
            await assert.rejects(f.run(), /précédente a été remise/);
            assert.equal(treeDigest(f.options.app), before);
            assert.ok(!f.events.includes("proton"));
            assert.equal(f.backups().length, 1);
        }
    });

    void it("should preserve the new profile and verified backups when launch cannot be confirmed", async () => {
        const f = fixture();
        const profileBefore = treeDigest(f.options.profile);
        f.options.host.launch = async () => {
            fs.writeFileSync(path.join(f.options.profile, "new-schema"), "migration after launch");
            throw new Error("launch timeout");
        };
        await assert.rejects(f.run(), /aucune restauration automatique après lancement/);
        assert.equal(treeDigest(f.options.app), treeDigest(f.source));
        assert.notEqual(treeDigest(f.options.profile), profileBefore);
        assert.equal(treeDigest(path.join(f.backups()[0], "profile-Element")), profileBefore);
    });

    void it("should support an absent profile without creating or deleting user data", async () => {
        const f = fixture();
        fs.rmSync(f.options.profile, { recursive: true });
        await f.run();
        assert.equal(fs.existsSync(f.options.profile), false);
        const backup = JSON.parse(fs.readFileSync(path.join(f.backups()[0], "backup.json"), "utf8"));
        assert.equal(backup.profileExisted, false);
        assert.equal(backup.profileDigest, null);
    });
});
