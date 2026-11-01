/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { expect, describe, it, beforeEach, vi } from "vitest";
import { fs as memfs, vol } from "memfs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

vi.mock("node:fs", () => ({ default: memfs }));

beforeEach(() => {
    // Reset the state of the in-memory fs
    vol.reset();
    vi.resetModules();
});

describe("getBuildConfig", () => {
    it("should read fields from package.json correctly", async () => {
        vol.fromJSON(
            {
                "../package.json": JSON.stringify({
                    electron_appId: "app.id",
                    electron_protocol: "proto",
                    electron_windows_cert_sn: "subject.name",
                }),
            },
            __dirname,
        );

        const { getBuildConfig } = await import("./build-config.js");
        const config = getBuildConfig();
        expect(config.appId).toBe("app.id");
        expect(config.protocol).toBe("proto");
        expect(config.windowsCertSubjectName).toBe("subject.name");
        expect(config.manualUpdates).toBe(false);
        expect(config.registerLegacyProtocol).toBe(true);
    });

    it.each([true, false, "true", undefined])(
        "should require a boolean manual-update build flag (%s)",
        async (value) => {
            vol.fromJSON({ "../package.json": JSON.stringify({ electron_manual_updates: value }) }, __dirname);
            const { getBuildConfig } = await import("./build-config.js");
            expect(getBuildConfig().manualUpdates).toBe(value === true);
        },
    );

    it.each([
        [false, undefined, true],
        [true, undefined, false],
        [true, true, true],
        [false, false, false],
        [true, "true", false],
        [false, "false", true],
    ])("should resolve legacy protocol policy independently (%s, %s)", async (manual, override, expected) => {
        vol.fromJSON(
            {
                "../package.json": JSON.stringify({
                    electron_manual_updates: manual,
                    electron_register_legacy_protocol: override,
                }),
            },
            __dirname,
        );
        const { getBuildConfig } = await import("./build-config.js");
        expect(getBuildConfig().registerLegacyProtocol).toBe(expected);
        expect(getBuildConfig().manualUpdates).toBe(manual);
    });

    it("should keep the packaged policy cached for the lifetime of the process", async () => {
        vol.fromJSON({ "../package.json": JSON.stringify({ electron_manual_updates: true }) }, __dirname);
        const { getBuildConfig } = await import("./build-config.js");
        expect(getBuildConfig().manualUpdates).toBe(true);
        vol.fromJSON({ "../package.json": JSON.stringify({ electron_manual_updates: false }) }, __dirname);
        expect(getBuildConfig().manualUpdates).toBe(true);
    });
});
