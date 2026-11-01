/*
Copyright 2026 Médéric

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { test, expect } from "../../element-desktop-test.js";

test.describe("macOS menu bar", () => {
    test.skip(process.platform !== "darwin", "macOS Dock behavior");
    test.use({ extraArgs: ["--no-update", "--storage-mode", "force-plaintext"] });

    test("keeps running after close and restores the Dock when reopened", async ({ app, page }) => {
        const window = await app.browserWindow(page);
        await expect.poll(() => window.evaluate((window) => window.isVisible())).toBe(true);
        await expect.poll(() => app.evaluate(({ app }) => app.dock!.isVisible())).toBe(true);

        await window.evaluate((window) => window.close());
        await expect.poll(() => app.evaluate(({ app }) => app.dock!.isVisible())).toBe(false);
        expect(await window.evaluate((window) => window.isDestroyed())).toBe(false);

        // Finder/Dock activation shares the same reveal path as the tray action.
        await app.evaluate(({ app }) => {
            app.emit("activate");
        });
        await expect.poll(() => app.evaluate(({ app }) => app.dock!.isVisible())).toBe(true);
        await expect.poll(() => window.evaluate((window) => window.isFocused())).toBe(true);
    });
});
