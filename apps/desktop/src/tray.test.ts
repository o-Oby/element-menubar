/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { expect, describe, it, beforeEach, afterEach, vi } from "vitest";
import { Tray, Menu, nativeImage, app, type BrowserWindow, type NativeImage } from "electron";

import { getConfig } from "./config.js";
import { getIconPath } from "./icon.js";
import { setMenuBarAvailable } from "./macos-dock.js";
import { revealMainWindow } from "./window-close.js";

vi.mock("electron", () => ({
    Tray: vi.fn(
        class {
            public setToolTip = vi.fn();
            public setContextMenu = vi.fn();
            public on = vi.fn();
            public destroy = vi.fn();
        },
    ),
    Menu: { buildFromTemplate: vi.fn() },
    nativeImage: { createFromPath: vi.fn() },
    app: { isPackaged: true, quit: vi.fn(), isHidden: vi.fn() },
}));
vi.mock("./icon.js");
vi.mock("./config.js");
vi.mock("./build-config.js", () => ({ getBuildConfig: () => ({}) }));
vi.mock("./macos-dock.js");
vi.mock("./window-close.js");

describe("tray", () => {
    let tray: typeof import("./tray.js");
    let icon: NativeImage;

    beforeEach(async () => {
        vi.resetModules();
        vi.clearAllMocks();
        vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
        global.mainWindow = null;
        vi.mocked(app.isHidden).mockReturnValue(false);
        icon = { isEmpty: vi.fn().mockReturnValue(false), setTemplateImage: vi.fn() } as unknown as NativeImage;
        vi.mocked(nativeImage.createFromPath).mockReturnValue(icon);
        vi.mocked(getIconPath).mockResolvedValue("/app/build/icon.png");
        vi.mocked(getConfig).mockReturnValue({ brand: "ChatApp", help_url: "HELP_URL", web_base_url: "WEB_BASE_URL" });
        tray = await import("./tray.js");
    });

    afterEach(() => vi.restoreAllMocks());

    it("uses the configured brand on Windows", async () => {
        vi.spyOn(process, "platform", "get").mockReturnValue("win32");
        await tray.create();
        expect(vi.mocked(Tray).mock.instances[0].setToolTip).toHaveBeenCalledWith("ChatApp");
        expect(vi.mocked(Tray).mock.instances[0].on).toHaveBeenCalledWith("click", expect.any(Function));
    });

    it("uses a native template with its Retina companion and a single menu interaction on macOS", async () => {
        global.mainWindow = { webContents: { on: vi.fn() } } as unknown as BrowserWindow;
        await tray.create();
        expect(nativeImage.createFromPath).toHaveBeenCalledWith("/app/build/menubarTemplate.png");
        expect(icon.setTemplateImage).toHaveBeenCalledWith(true);
        expect(tray.hasTray()).toBe(true);
        expect(setMenuBarAvailable).toHaveBeenCalledWith(true);
        expect(vi.mocked(Tray).mock.instances[0].on).not.toHaveBeenCalled();
        expect(global.mainWindow.webContents.on).not.toHaveBeenCalled();
        await tray.create();
        expect(Tray).toHaveBeenCalledTimes(1);
    });

    it("fails before hiding the Dock if the icon is missing", async () => {
        vi.mocked(icon.isEmpty).mockReturnValue(true);
        await expect(tray.create()).rejects.toThrow("Tray icon resource is missing");
        expect(tray.hasTray()).toBe(false);
        expect(setMenuBarAvailable).not.toHaveBeenCalledWith(true);
    });

    it("removes an unusable tray after menu setup fails", async () => {
        vi.mocked(Menu.buildFromTemplate).mockImplementationOnce(() => {
            throw new Error("Menu unavailable");
        });
        await expect(tray.create()).rejects.toThrow("Menu unavailable");
        expect(tray.hasTray()).toBe(false);
        expect(vi.mocked(Tray).mock.instances[0].destroy).toHaveBeenCalled();
        expect(setMenuBarAvailable).toHaveBeenCalledWith(false);
    });

    it("retains the tray if restoring the Dock fails when disabling it", async () => {
        await tray.create();
        vi.mocked(setMenuBarAvailable).mockRejectedValueOnce(new Error("Dock unavailable"));
        await expect(tray.destroy()).rejects.toThrow("Dock unavailable");
        expect(tray.hasTray()).toBe(true);
        expect(vi.mocked(Tray).mock.instances[0].destroy).not.toHaveBeenCalled();
    });

    it("restores the Dock before removing the tray", async () => {
        await tray.create();
        let restore!: () => void;
        vi.mocked(setMenuBarAvailable).mockReturnValueOnce(new Promise((resolve) => (restore = resolve)));
        const disabling = tray.destroy();
        expect(tray.hasTray()).toBe(true);
        restore();
        await disabling;
        expect(tray.hasTray()).toBe(false);
    });

    it("serializes disable and re-enable while the Dock is being restored", async () => {
        await tray.create();
        let restore!: () => void;
        vi.mocked(setMenuBarAvailable).mockReturnValueOnce(new Promise((resolve) => (restore = resolve)));
        const disabling = tray.destroy();
        const enabling = tray.create();
        restore();
        await Promise.all([disabling, enabling]);
        expect(tray.hasTray()).toBe(true);
        expect(Tray).toHaveBeenCalledTimes(2);
        expect(vi.mocked(Tray).mock.instances[0].destroy).toHaveBeenCalled();
        expect(vi.mocked(Tray).mock.instances[1].destroy).not.toHaveBeenCalled();
    });

    it("does not create duplicate trays for simultaneous enable requests", async () => {
        await Promise.all([tray.create(), tray.create()]);
        expect(Tray).toHaveBeenCalledTimes(1);
    });

    it("reopens a hidden app and sends an open window through the normal close path", async () => {
        global.mainWindow = {
            isVisible: vi.fn().mockReturnValue(true),
            isMinimized: vi.fn().mockReturnValue(false),
            isFocused: vi.fn().mockReturnValue(false),
            close: vi.fn(),
        } as unknown as BrowserWindow;
        await tray.create();
        const action = vi.mocked(Menu.buildFromTemplate).mock.calls[0][0][0].click!;
        // A visible but unfocused window still closes when the native menu takes focus.
        action({} as Electron.MenuItem, global.mainWindow, {} as Electron.KeyboardEvent);
        expect(global.mainWindow.close).toHaveBeenCalled();
        expect(revealMainWindow).not.toHaveBeenCalled();
        // app.hide() leaves BrowserWindow.isVisible() true, but the menu must reopen it.
        vi.mocked(app.isHidden).mockReturnValue(true);
        action({} as Electron.MenuItem, global.mainWindow, {} as Electron.KeyboardEvent);
        expect(revealMainWindow).toHaveBeenCalledWith(global.mainWindow);
    });

    it("really quits from the menu", async () => {
        await tray.create();
        const action = vi.mocked(Menu.buildFromTemplate).mock.calls[0][0][2].click!;
        action({} as Electron.MenuItem, undefined, {} as Electron.KeyboardEvent);
        expect(app.quit).toHaveBeenCalled();
    });
});
