/*
Copyright 2026 Médéric

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { ipcMain, type IpcMainInvokeEvent } from "electron";

import Store from "./store.js";
import * as tray from "./tray.js";

vi.mock("electron", () => ({ ipcMain: { handle: vi.fn() } }));
vi.mock("./tray.js");
vi.mock("./auto-launch.js", () => ({ AutoLaunch: {} }));
vi.mock("./store.js", () => ({ default: { instance: { set: vi.fn() } } }));

describe("menu bar preference", () => {
    beforeEach(async () => {
        vi.resetModules();
        vi.clearAllMocks();
        vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
        await import("./settings.js");
    });

    afterEach(() => vi.restoreAllMocks());

    function handler(name: string): Parameters<typeof ipcMain.handle>[1] {
        return vi.mocked(ipcMain.handle).mock.calls.find(([channel]) => channel === name)![1];
    }

    it("exposes the existing tray setting on macOS", async () => {
        const supported = await handler("getSupportedSettings")({} as IpcMainInvokeEvent);
        expect(supported["Electron.showTrayIcon"]).toBe(true);
    });

    it("persists only after enabling the tray succeeds", async () => {
        await handler("setSettingValue")({} as IpcMainInvokeEvent, "Electron.showTrayIcon", true);
        expect(tray.create).toHaveBeenCalled();
        expect(Store.instance!.set).toHaveBeenCalledWith("minimizeToTray", true);
    });

    it("does not persist a disabled setting until the Dock has been restored", async () => {
        vi.mocked(tray.destroy).mockRejectedValueOnce(new Error("Dock unavailable"));
        await expect(
            handler("setSettingValue")({} as IpcMainInvokeEvent, "Electron.showTrayIcon", false),
        ).rejects.toThrow("Dock unavailable");
        expect(Store.instance!.set).not.toHaveBeenCalled();
    });
});
