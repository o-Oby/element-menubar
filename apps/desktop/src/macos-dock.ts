/*
Copyright 2026 Médéric

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { app } from "electron";

let menuBarAvailable = false;
let backgrounded = false;
let lastHideTime = -Infinity;
let lastShowTime = -Infinity;
let hideTimer: ReturnType<typeof setTimeout> | undefined;
let showing: Promise<void> | undefined;

function cancelScheduledHide(): void {
    clearTimeout(hideTimer);
    hideTimer = undefined;
}

function hideDockWhenReady(): void {
    cancelScheduledHide();
    if (!menuBarAvailable || !backgrounded || global.appQuitting || showing || !app.dock?.isVisible()) return;

    // Electron ignores dock.hide() within one second of dock.show().
    const delay = Math.max(0, 1100 - (Date.now() - Math.max(lastHideTime, lastShowTime)));
    if (delay > 0) {
        hideTimer = setTimeout(hideDockWhenReady, delay);
        return;
    }
    app.dock.hide();
    lastHideTime = Date.now();
}

/** Hide the Dock only after closing to a working menu bar, or starting hidden. */
export function backgroundToMenuBar(): void {
    if (process.platform !== "darwin" || !menuBarAvailable || global.appQuitting) return;
    backgrounded = true;
    hideDockWhenReady();
}

async function waitForDockVisible(): Promise<void> {
    const deadline = Date.now() + 5000;
    // Electron's inactive-app path resolves dock.show() before the native activation policy changes.
    while (!global.appQuitting && !app.dock?.isVisible()) {
        if (Date.now() >= deadline) throw new Error("The Dock did not become visible after being restored");
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
}

/** Restore the Dock and cancel any delayed hide before revealing a window. */
export async function restoreDock(): Promise<void> {
    if (process.platform !== "darwin") return;
    backgrounded = false;
    cancelScheduledHide();
    if (showing) return showing;
    if (!app.dock || app.dock.isVisible()) return;

    lastShowTime = Date.now();
    showing = app.dock
        .show()
        .then(waitForDockVisible)
        .finally(() => {
            showing = undefined;
            // A close can arrive while macOS is asynchronously restoring the Dock.
            if (backgrounded) hideDockWhenReady();
        });
    return showing;
}

/** Keep a recovery entry point: restore the Dock before removing the menu bar icon. */
export async function setMenuBarAvailable(available: boolean): Promise<void> {
    if (process.platform !== "darwin") return;
    const previous = menuBarAvailable;
    menuBarAvailable = available;
    if (!available) {
        try {
            await restoreDock();
        } catch (error) {
            menuBarAvailable = previous;
            throw error;
        }
    }
}

/** Cancel delayed work when a real quit starts. */
export function stopDockUpdates(): void {
    backgrounded = false;
    cancelScheduledHide();
}
