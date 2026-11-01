/*
Copyright 2026 o-Oby

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app, autoUpdater, ipcMain, type BrowserWindow } from "electron";
import os from "node:os";

import { getBuildConfig } from "./build-config.js";

vi.mock("electron", async () => {
    const { EventEmitter } = await import("node:events");
    return {
        app: { getVersion: vi.fn(() => "1.12.33") },
        autoUpdater: Object.assign(new EventEmitter(), {
            setFeedURL: vi.fn(),
            getFeedURL: vi.fn(() => "https://packages.element.io/desktop/update/macos/releases.json"),
            checkForUpdates: vi.fn(),
            quitAndInstall: vi.fn(),
        }),
        ipcMain: new EventEmitter(),
    };
});
vi.mock("./build-config.js", () => ({ getBuildConfig: vi.fn() }));
vi.mock("./squirrelhooks.js", () => ({ getSquirrelExecutable: vi.fn() }));
vi.mock("./language-helper.js", () => ({ _t: vi.fn((key: string) => key) }));
vi.mock("./ipc.js", () => ({ initialisePromise: Promise.resolve() }));
vi.mock("./config.js", () => ({ getConfig: vi.fn(() => ({ brand: "Element Menu Bar" })) }));

const send = vi.fn();
const fetchMock = vi.fn();
let start: typeof import("./updater.js").start;

function setManualUpdates(manualUpdates: boolean): void {
    vi.mocked(getBuildConfig).mockReturnValue({
        manualUpdates,
        appId: "io.github.o-oby.element-menubar",
        protocol: "element-menubar",
        windowsCertSubjectName: undefined,
        registerLegacyProtocol: true,
    });
}

beforeEach(async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    vi.resetModules();
    autoUpdater.removeAllListeners();
    ipcMain.removeAllListeners();
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    vi.spyOn(os, "release").mockReturnValue("26.0.0");
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("mainWindow", { webContents: { send } } as unknown as BrowserWindow);
    vi.stubGlobal("appQuitting", false);
    fetchMock.mockResolvedValue({ json: async () => ({ currentRelease: "1.12.34" }) });
    setManualUpdates(true);
    ({ start } = await import("./updater.js"));
});

afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe("updater manual build policy", () => {
    it("should refuse an official update feed without starting timers or EOL checks", async () => {
        vi.mocked(os.release).mockReturnValue("20.0.0");
        const showToast = vi.fn();
        ipcMain.on("showToast", showToast);

        await start("https://packages.element.io/desktop/update/");

        expect(autoUpdater.setFeedURL).not.toHaveBeenCalled();
        expect(fetchMock).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
        expect(os.release).not.toHaveBeenCalled();
        expect(showToast).not.toHaveBeenCalled();
    });

    it("should answer a renderer check without contacting or installing an update", async () => {
        ipcMain.emit("check_updates");
        ipcMain.emit("install_update");
        await Promise.resolve();

        expect(send).toHaveBeenCalledExactlyOnceWith("check_updates", false);
        expect(autoUpdater.getFeedURL).not.toHaveBeenCalled();
        expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled();
        expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();
        expect(fetchMock).not.toHaveBeenCalled();
        expect(global.appQuitting).toBe(false);
    });

    it("should ignore updater events including a previously downloaded official binary", () => {
        autoUpdater.emit("update-available");
        autoUpdater.emit(
            "update-downloaded",
            {},
            "notes",
            "1.12.34",
            new Date(),
            "https://packages.element.io/update.zip",
        );
        autoUpdater.emit("update-not-available");
        autoUpdater.emit("error", new Error("stale updater error"));
        ipcMain.emit("install_update");

        expect(send).not.toHaveBeenCalled();
        expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();
        expect(global.appQuitting).toBe(false);
    });
});

describe("updater standard build", () => {
    beforeEach(() => setManualUpdates(false));

    it("should retain the normal timed macOS update check", async () => {
        await start("https://packages.element.io/desktop/update");
        expect(autoUpdater.setFeedURL).toHaveBeenCalledWith({
            url: "https://packages.element.io/desktop/update/macos/releases.json",
            serverType: "json",
        });
        await vi.advanceTimersByTimeAsync(30_000);
        expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
            "https://packages.element.io/desktop/update/macos/releases.json",
        );
        expect(autoUpdater.checkForUpdates).toHaveBeenCalledOnce();
        expect(app.getVersion).toHaveBeenCalled();
    });

    it("should retain downloaded update notifications and installation", async () => {
        const releaseDate = new Date();
        autoUpdater.emit("update-available");
        expect(send).toHaveBeenLastCalledWith("check_updates", true);
        autoUpdater.emit("update-downloaded", {}, "notes", "1.12.34", releaseDate, "https://example.org/update.zip");
        expect(send).toHaveBeenLastCalledWith("update-downloaded", {
            releaseNotes: "notes",
            releaseName: "1.12.34",
            releaseDate,
            updateURL: "https://example.org/update.zip",
        });
        ipcMain.emit("check_updates");
        await Promise.resolve();
        expect(fetchMock).not.toHaveBeenCalled();
        ipcMain.emit("install_update");
        expect(global.appQuitting).toBe(true);
        expect(autoUpdater.quitAndInstall).toHaveBeenCalledOnce();
    });
});
