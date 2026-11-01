/*
Copyright 2026 Médéric

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "electron";

vi.mock("electron", () => ({
    app: { dock: { hide: vi.fn(), show: vi.fn(), isVisible: vi.fn() } },
}));

describe("macOS Dock lifecycle", () => {
    let dock: typeof import("./macos-dock.js");
    let visible: boolean;

    beforeEach(async () => {
        vi.resetModules();
        vi.useFakeTimers();
        vi.clearAllMocks();
        vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
        global.appQuitting = false;
        visible = true;
        vi.mocked(app.dock!.isVisible).mockImplementation(() => visible);
        vi.mocked(app.dock!.hide).mockImplementation(() => {
            visible = false;
        });
        vi.mocked(app.dock!.show).mockImplementation(async () => {
            visible = true;
        });
        dock = await import("./macos-dock.js");
    });

    afterEach(() => {
        dock.stopDockUpdates();
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it("never hides the only entry point when there is no tray", () => {
        dock.backgroundToMenuBar();
        expect(app.dock!.hide).not.toHaveBeenCalled();
    });

    it("keeps the Dock on launch and hides it only when explicitly backgrounded", async () => {
        await dock.setMenuBarAvailable(true);
        expect(app.dock!.hide).not.toHaveBeenCalled();
        dock.backgroundToMenuBar();
        expect(visible).toBe(false);
        await dock.restoreDock();
        expect(visible).toBe(true);
    });

    it("coalesces rapid closes and cancels a stale delayed hide on reopen", async () => {
        await dock.setMenuBarAvailable(true);
        dock.backgroundToMenuBar();
        await dock.restoreDock();
        dock.backgroundToMenuBar();
        expect(app.dock!.hide).toHaveBeenCalledTimes(1);
        await dock.restoreDock();
        await vi.advanceTimersByTimeAsync(1200);
        expect(visible).toBe(true);
        expect(app.dock!.hide).toHaveBeenCalledTimes(1);
    });

    it("eventually hides again after a rapid close, reopen, and close", async () => {
        await dock.setMenuBarAvailable(true);
        dock.backgroundToMenuBar();
        await dock.restoreDock();
        dock.backgroundToMenuBar();
        await vi.advanceTimersByTimeAsync(1100);
        expect(visible).toBe(false);
        expect(app.dock!.hide).toHaveBeenCalledTimes(2);
    });

    it("applies a close that arrives during an asynchronous Dock show", async () => {
        await dock.setMenuBarAvailable(true);
        dock.backgroundToMenuBar();
        let finishShow!: () => void;
        vi.mocked(app.dock!.show).mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    finishShow = () => {
                        visible = true;
                        resolve();
                    };
                }),
        );
        const show = dock.restoreDock();
        dock.backgroundToMenuBar();
        finishShow();
        await show;
        await vi.advanceTimersByTimeAsync(1100);
        expect(visible).toBe(false);
    });

    it("restores the Dock before allowing the tray to be disabled", async () => {
        await dock.setMenuBarAvailable(true);
        dock.backgroundToMenuBar();
        await dock.setMenuBarAvailable(false);
        dock.backgroundToMenuBar();
        await vi.advanceTimersByTimeAsync(1200);
        expect(visible).toBe(true);
    });

    it("preserves the tray state when restoring the Dock fails", async () => {
        await dock.setMenuBarAvailable(true);
        dock.backgroundToMenuBar();
        vi.mocked(app.dock!.show).mockRejectedValueOnce(new Error("Dock unavailable"));
        await expect(dock.setMenuBarAvailable(false)).rejects.toThrow("Dock unavailable");
        await dock.restoreDock();
        dock.backgroundToMenuBar();
        await vi.advanceTimersByTimeAsync(1100);
        expect(visible).toBe(false);
    });

    it("cancels pending hides on quit", async () => {
        await dock.setMenuBarAvailable(true);
        dock.backgroundToMenuBar();
        await dock.restoreDock();
        dock.backgroundToMenuBar();
        global.appQuitting = true;
        dock.stopDockUpdates();
        await vi.advanceTimersByTimeAsync(1200);
        expect(visible).toBe(true);
    });

    it("does not change the Dock on other platforms", async () => {
        vi.spyOn(process, "platform", "get").mockReturnValue("linux");
        await dock.setMenuBarAvailable(true);
        dock.backgroundToMenuBar();
        await dock.restoreDock();
        expect(app.dock!.hide).not.toHaveBeenCalled();
        expect(app.dock!.show).not.toHaveBeenCalled();
    });
});
