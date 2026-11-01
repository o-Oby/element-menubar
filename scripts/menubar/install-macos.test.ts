/*
Copyright 2026 o-Oby

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
    assertNoDowngrade,
    hasProtonArguments,
    launchViaProton,
    quitElement,
    readAsarPackage,
    type MacRuntime,
} from "./install-macos.ts";

const temporaryDirectories: string[] = [];
const MAIN = "/Applications/Element.app/Contents/MacOS/Element";
const PROXY = "--proxy-server=socks5://127.0.0.1:25344";
const RESOLVER = "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1";
const WEBRTC = "--force-webrtc-ip-handling-policy=disable_non_proxied_udp";
const PROTECTED = `${MAIN} ${PROXY} ${RESOLVER} ${WEBRTC}`;

function archive(header: unknown, payload = Buffer.from("{}")): Buffer {
    const json = Buffer.from(JSON.stringify(header));
    const pickle = Buffer.alloc(8 + Math.ceil(json.length / 4) * 4);
    pickle.writeUInt32LE(pickle.length - 4, 0);
    pickle.writeUInt32LE(json.length, 4);
    json.copy(pickle, 8);
    const size = Buffer.alloc(8);
    size.writeUInt32LE(4, 0);
    size.writeUInt32LE(pickle.length, 4);
    return Buffer.concat([size, pickle, payload]);
}

function writeArchive(bytes: Buffer): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "element-asar-test-"));
    temporaryDirectories.push(directory);
    const filename = path.join(directory, "app.asar");
    fs.writeFileSync(filename, bytes);
    return filename;
}

function runtimeFixture(lines: string[]): {
    runtime: MacRuntime;
    calls: { binary: string; args: string[]; timeout?: number }[];
    setLines: (lines: string[]) => void;
    elapsed: () => number;
} {
    let elapsed = 0;
    const calls: { binary: string; args: string[]; timeout?: number }[] = [];
    return {
        runtime: {
            processes: () => lines,
            now: () => elapsed,
            wait: async (milliseconds) => {
                elapsed += milliseconds;
            },
            command: (binary, args, timeout) => {
                calls.push({ binary, args, timeout });
                if (binary === "/usr/bin/osascript") lines = [];
                if (binary === "/usr/bin/open") lines = [PROTECTED];
                return "";
            },
        },
        calls,
        setLines: (next) => {
            lines = next;
        },
        elapsed: () => elapsed,
    };
}

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

void describe("macOS installer native boundaries", () => {
    void it("should read a packed root package without requiring project node_modules", () => {
        const metadata = { version: "1.12.33", electron_manual_updates: true, productName: "Element" };
        const payload = Buffer.from(JSON.stringify(metadata));
        const file = writeArchive(
            archive(
                { files: { "package.json": { size: payload.length, offset: "3" } } },
                Buffer.concat([Buffer.from("pad"), payload]),
            ),
        );
        assert.deepEqual(readAsarPackage(file), metadata);
    });

    void it("should reject truncated, oversized, invalid or external ASAR metadata", () => {
        const valid = archive({ files: { "package.json": { size: 2, offset: "0" } } });
        const badPrefix = Buffer.from(valid);
        badPrefix.writeUInt32LE(8, 0);
        const hugeHeader = Buffer.from(valid);
        hugeHeader.writeUInt32LE(128 * 1024 * 1024, 4);
        const invalidPickle = Buffer.from(valid);
        invalidPickle.writeUInt32LE(0, 8);
        const invalidJson = Buffer.from(valid);
        invalidJson[16] = 0x21;
        const cases = [
            valid.subarray(0, 6),
            valid.subarray(0, valid.length - 1),
            badPrefix,
            hugeHeader,
            invalidPickle,
            invalidJson,
            archive(null),
            archive({ files: {} }),
            archive({ files: { "package.json": { size: 2, offset: "0", unpacked: true } } }),
            archive({ files: { "package.json": { size: 2, offset: "0", link: "../../private" } } }),
            archive({ files: { "package.json": { size: 2, offset: "9007199254740993" } } }),
            archive({ files: { "package.json": { size: 2, offset: "-1" } } }),
            archive({ files: { "package.json": { size: 2, offset: "2oops" } } }),
            archive({ files: { "package.json": { size: 1024 * 1024 + 1, offset: "0" } } }),
            archive({ files: { "package.json": { size: 2, offset: "0" } } }, Buffer.from("[]")),
        ];
        for (const bytes of cases) assert.throws(() => readAsarPackage(writeArchive(bytes)), /ASAR invalide/);
    });

    void it("should reject symlinked metadata archives instead of following them", () => {
        const target = writeArchive(archive({ files: { "package.json": { size: 2, offset: "0" } } }));
        const link = path.join(path.dirname(target), "linked.asar");
        fs.symlinkSync(target, link);
        assert.throws(() => readAsarPackage(link));
    });

    void it("should reject downgrades and unknown versions before installation", () => {
        for (const [installed, target] of [
            ["1.12.33", "1.12.33"],
            ["1.9.99", "1.10.0"],
            ["1.99.99", "2.0.0"],
        ]) {
            assertNoDowngrade(installed, target);
        }
        for (const [installed, target] of [
            ["2.0.0", "1.99.99"],
            ["1.13.0", "1.12.99"],
            ["1.12.34", "1.12.33"],
        ]) {
            assert.throws(() => assertNoDowngrade(installed, target), /plus récent/);
        }
        for (const version of [undefined, null, 12, "1.12", "1.12.33-beta.1"]) {
            assert.throws(() => assertNoDowngrade(version, "1.12.33"), /non reconnue/);
        }
    });

    void it("should require complete non-conflicting proxy, DNS and WebRTC arguments", () => {
        assert.equal(hasProtonArguments(PROTECTED), true);
        assert.equal(hasProtonArguments(`${MAIN} ${PROXY}`), false);
        assert.equal(hasProtonArguments(PROTECTED.replace("25344", "253440")), false);
        assert.equal(hasProtonArguments(`${PROTECTED} --proxy-server=direct://`), false);
        assert.equal(hasProtonArguments(`${PROTECTED} --host-resolver-rules=MAP * other.invalid`), false);
        assert.equal(hasProtonArguments(`${PROTECTED} ${WEBRTC}`), false);
    });

    void it("should avoid Apple events when stopped and guard quit against an already stopped main process", async () => {
        const stopped = runtimeFixture([]);
        await quitElement(stopped.runtime);
        assert.deepEqual(stopped.calls, []);
        const running = runtimeFixture([PROTECTED]);
        await quitElement(running.runtime);
        assert.equal(running.calls.length, 1);
        assert.equal(running.calls[0].binary, "/usr/bin/osascript");
        assert.match(running.calls[0].args[1], /if application "\/Applications\/Element\.app" is running then/);
    });

    void it("should include the Apple event in the 45-second graceful quit deadline without killing", async () => {
        const fixture = runtimeFixture([PROTECTED]);
        fixture.runtime.command = (binary, args, timeout) => {
            fixture.calls.push({ binary, args, timeout });
            // Model a blocking Apple event timeout without invoking any native process.
            const originalNow = fixture.runtime.now;
            fixture.runtime.now = () => originalNow() + 15_000;
            throw new Error("Apple event timed out");
        };
        await assert.rejects(quitElement(fixture.runtime), /n’a pas quitté/);
        assert.equal(fixture.elapsed(), 30_000);
        assert.deepEqual(
            fixture.calls.map((call) => call.binary),
            ["/usr/bin/osascript"],
        );
    });

    void it("should quit an incompletely protected instance before opening only the Proton launcher", async () => {
        const fixture = runtimeFixture([`${MAIN} ${PROXY}`]);
        await launchViaProton(fixture.runtime);
        assert.deepEqual(
            fixture.calls.map((call) => call.binary),
            ["/usr/bin/osascript", "/usr/bin/open"],
        );
        assert.deepEqual(fixture.calls[1].args, ["/Applications/Element (Proton).app"]);
        assert.equal(fixture.elapsed(), 3_000);
    });

    void it("should leave a correctly protected running instance open", async () => {
        const fixture = runtimeFixture([PROTECTED]);
        await launchViaProton(fixture.runtime);
        assert.deepEqual(
            fixture.calls.map((call) => call.binary),
            ["/usr/bin/open"],
        );
    });

    void it("should refuse launch confirmation if the process exits or loses required flags", async () => {
        const fixture = runtimeFixture([]);
        const originalWait = fixture.runtime.wait;
        fixture.runtime.wait = async (milliseconds) => {
            await originalWait(milliseconds);
            if (fixture.elapsed() >= 1_000) fixture.setLines([`${MAIN} ${PROXY}`]);
        };
        await assert.rejects(launchViaProton(fixture.runtime), /n’a pas été confirmé/);
        assert.equal(fixture.elapsed(), 45_000);
        assert.deepEqual(
            fixture.calls.map((call) => call.binary),
            ["/usr/bin/open"],
        );
    });
});
