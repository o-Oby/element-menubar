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
        await expect.poll(() => app.evaluate(({ app }) => app.isHidden())).toBe(true);
        await expect.poll(() => window.evaluate((window) => window.isFocused())).toBe(false);

        // Verify that reopening gives focus, even if another app takes it again while the build runs.
        const windowId = await window.evaluate((window) => window.id);
        await app.evaluate(
            ({ app, BrowserWindow }, windowId) =>
                new Promise<void>((resolve, reject) => {
                    const window = BrowserWindow.fromId(windowId)!;
                    const focused = (): void => {
                        clearTimeout(timeout);
                        resolve();
                    };
                    const timeout = setTimeout(() => {
                        window.removeListener("focus", focused);
                        reject(new Error("Reopening did not focus the Element window"));
                    }, 5_000);
                    window.once("focus", focused);
                    // Finder/Dock activation shares the same reveal path as the tray action.
                    app.emit("activate");
                }),
            windowId,
        );
        await expect.poll(() => app.evaluate(({ app }) => app.dock!.isVisible())).toBe(true);
        await expect.poll(() => app.evaluate(({ app }) => app.isHidden())).toBe(false);
        await expect.poll(() => window.evaluate((window) => window.isVisible())).toBe(true);
    });
});
