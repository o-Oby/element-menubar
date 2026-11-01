/*
Copyright 2024-2025 New Vector Ltd.
Copyright 2017 Karl Glatz <karl@glatz.biz>
Copyright 2017 OpenMarket Ltd

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { app, Tray, Menu, nativeImage } from "electron";
import { v5 as uuidv5 } from "uuid";
import { writeFile } from "node:fs/promises";
import pngToIco from "png-to-ico";
import path from "node:path";

import { _t } from "./language-helper.js";
import { getBuildConfig } from "./build-config.js";
import { getIconPath } from "./icon.js";
import { getConfig } from "./config.js";
import { revealMainWindow } from "./window-close.js";
import { setMenuBarAvailable } from "./macos-dock.js";

// This hardcoded uuid is an arbitrary v4 uuid generated on https://www.uuidgenerator.net/version4
const UUID_NAMESPACE = "9fc9c6a0-9ffe-45c9-9cd7-5639ae38b232";

let trayIcon: Tray | null = null;
let trayOperation = Promise.resolve();

function enqueue(operation: () => Promise<void>): Promise<void> {
    const result = trayOperation.then(operation);
    // A failed operation must not block later preference changes; the caller gets the failure.
    trayOperation = result.catch(() => {});
    return result;
}

export function hasTray(): boolean {
    return trayIcon !== null;
}

/** Restore the Dock before removing the tray; serialize concurrent preference changes. */
export function destroy(): Promise<void> {
    return enqueue(destroyTray);
}

async function destroyTray(): Promise<void> {
    await setMenuBarAvailable(false);
    if (trayIcon) {
        trayIcon.destroy();
        trayIcon = null;
    }
}

function toggleWin(): void {
    const window = global.mainWindow;
    if (!window) return;
    if (process.platform === "darwin") {
        // Opening the native menu can take focus away; app.hide() also leaves isVisible() true.
        if (window.isVisible() && !window.isMinimized() && !app.isHidden()) {
            window.close();
        } else {
            void revealMainWindow(window);
        }
    } else if (window.isVisible() && !window.isMinimized() && window.isFocused()) {
        window.hide();
    } else {
        void revealMainWindow(window);
    }
}

/** Create a tray at most once, after any in-flight removal has completed. */
export function create(): Promise<void> {
    return enqueue(createTray);
}

async function createTray(): Promise<void> {
    if (trayIcon) return;
    const iconPath = await getIconPath();
    const defaultIcon = nativeImage.createFromPath(
        process.platform === "darwin" ? path.join(path.dirname(iconPath), "menubarTemplate.png") : iconPath,
    );
    if (defaultIcon.isEmpty()) throw new Error("Tray icon resource is missing");
    if (process.platform === "darwin") defaultIcon.setTemplateImage(true);

    const buildConfig = getBuildConfig();
    if (process.platform === "win32" && app.isPackaged && buildConfig.windowsCertSubjectName) {
        // Providing a GUID lets Windows be smarter about maintaining user's tray preferences
        // https://github.com/electron/electron/pull/21891
        // We generate the GUID in a custom arbitrary namespace and use the subject name & userData path
        // to differentiate different app builds on the same system.
        const guid = uuidv5(`${buildConfig.windowsCertSubjectName}:${app.getPath("userData")}`, UUID_NAMESPACE);
        trayIcon = new Tray(defaultIcon, guid);
    } else {
        trayIcon = new Tray(defaultIcon);
    }

    try {
        trayIcon.setToolTip(getConfig().brand);
        initApplicationMenu();
        // macOS opens the native menu on click; also toggling the window would race it.
        if (process.platform !== "darwin") trayIcon.on("click", toggleWin);
        await setMenuBarAvailable(true);
    } catch (error) {
        await destroyTray();
        throw error;
    }

    // Keep the macOS template monochrome instead of replacing it with web favicons.
    if (process.platform === "darwin") return;

    // See also, badge.ts
    let lastFavicon: string | null = null;
    global.mainWindow?.webContents.on("page-favicon-updated", async function (ev, favicons) {
        if (!favicons || favicons.length <= 0 || !favicons[0].startsWith("data:")) {
            if (lastFavicon !== null) {
                global.mainWindow?.setIcon(defaultIcon);
                trayIcon?.setImage(defaultIcon);
                lastFavicon = null;
            }
            return;
        }

        // No need to change, shortcut
        if (favicons[0] === lastFavicon) return;
        lastFavicon = favicons[0];

        let newFavicon = nativeImage.createFromDataURL(favicons[0]);

        // Windows likes ico's too much.
        if (process.platform === "win32") {
            try {
                const icoPath = path.join(app.getPath("temp"), "win32_element_icon.ico");
                await writeFile(icoPath, await pngToIco(newFavicon.toPNG()));
                newFavicon = nativeImage.createFromPath(icoPath);
            } catch (e) {
                console.error("Failed to make win32 ico", e);
            }
            // Always update the tray icon for Windows.
            trayIcon?.setImage(newFavicon);
        } else {
            trayIcon?.setImage(newFavicon);
            global.mainWindow?.setIcon(newFavicon);
        }
    });

    global.mainWindow?.webContents.on("page-title-updated", function (ev, title) {
        trayIcon?.setToolTip(title);
    });
}

export function initApplicationMenu(): void {
    if (!trayIcon) {
        return;
    }

    const contextMenu = Menu.buildFromTemplate([
        {
            label: _t("action|show_hide"),
            click: toggleWin,
        },
        { type: "separator" },
        {
            label: _t("action|quit"),
            click: function (): void {
                app.quit();
            },
        },
    ]);

    trayIcon.setContextMenu(contextMenu);
}
