/*
Copyright 2026 o-Oby

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { installDelivery, type InstallHost } from "./install.ts";

const APP = "/Applications/Element.app";
const PROTON = "/Applications/Element (Proton).app";
const PROFILE = path.join(os.homedir(), "Library/Application Support/Element");
const BACKUPS = path.join(os.homedir(), "Library/Application Support/Element Fork Backups");
const PROXY = "--proxy-server=socks5://127.0.0.1:25344";
const RESOLVER = "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1";
const WEBRTC = "--force-webrtc-ip-handling-policy=disable_non_proxied_udp";
const MAX_HEADER_BYTES = 64 * 1024 * 1024;
const MAX_PACKAGE_BYTES = 1024 * 1024;

function command(binary: string, args: string[], timeout = 60_000): string {
    return execFileSync(binary, args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout,
        maxBuffer: 16 * 1024 * 1024,
    }).trim();
}

function processes(): string[] {
    return command("/bin/ps", ["-axww", "-o", "command="], 5_000)
        .split("\n")
        .map((line) => line.trim());
}

function elementProcesses(lines: string[]): string[] {
    return lines.filter(
        (line) => line.startsWith(`${APP}/Contents/`) || /\/Element\.app\/Contents\/MacOS\/Element(?: |$)/.test(line),
    );
}

function mainProcesses(lines: string[]): string[] {
    return lines.filter(
        (line) => line.startsWith(`${APP}/Contents/MacOS/Element `) || line === `${APP}/Contents/MacOS/Element`,
    );
}

function assertStopped(): void {
    if (elementProcesses(processes()).length) {
        throw new Error("Element est encore ouvert ou a été relancé. Quittez-le et réessayez.");
    }
}

function record(value: unknown): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("Objet JSON attendu.");
    }
    return value as Record<string, unknown>;
}

function readExactly(fd: number, length: number, position: number): Buffer {
    const buffer = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
        const count = fs.readSync(fd, buffer, read, length - read, position + read);
        if (!count) throw new Error("Archive tronquée.");
        read += count;
    }
    return buffer;
}

/** Read only the packed root package.json; no dependencies, unpacked files or archive links are followed. */
export function readAsarPackage(archive: string): Record<string, unknown> {
    const fd = fs.openSync(archive, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || !Number.isSafeInteger(stat.size)) throw new Error("Fichier ordinaire attendu.");
        const prefix = readExactly(fd, 8, 0);
        const headerSize = prefix.readUInt32LE(4);
        if (
            prefix.readUInt32LE(0) !== 4 ||
            headerSize < 8 ||
            headerSize % 4 !== 0 ||
            headerSize > MAX_HEADER_BYTES ||
            headerSize > stat.size - 8
        ) {
            throw new Error("Taille de l’en-tête invalide.");
        }
        const header = readExactly(fd, headerSize, 8);
        const jsonSize = header.readUInt32LE(4);
        if (
            header.readUInt32LE(0) !== headerSize - 4 ||
            jsonSize < 1 ||
            jsonSize > headerSize - 8 ||
            8 + Math.ceil(jsonSize / 4) * 4 !== headerSize
        ) {
            throw new Error("En-tête Pickle invalide.");
        }
        const files = record(record(JSON.parse(header.subarray(8, 8 + jsonSize).toString("utf8"))).files);
        const entry = record(files["package.json"]);
        const size = entry.size;
        const offset = typeof entry.offset === "string" && /^\d+$/.test(entry.offset) ? Number(entry.offset) : NaN;
        if (
            "link" in entry ||
            "files" in entry ||
            (entry.unpacked !== undefined && entry.unpacked !== false) ||
            typeof size !== "number" ||
            !Number.isSafeInteger(size) ||
            size < 1 ||
            size > MAX_PACKAGE_BYTES ||
            !Number.isSafeInteger(offset) ||
            offset < 0
        ) {
            throw new Error("Entrée package.json invalide ou non embarquée.");
        }
        const position = 8 + headerSize + offset;
        if (!Number.isSafeInteger(position + size) || position + size > stat.size) {
            throw new Error("package.json dépasse la taille de l’archive.");
        }
        return record(JSON.parse(readExactly(fd, size, position).toString("utf8")));
    } catch (error) {
        throw new Error(`Archive ASAR invalide : ${error instanceof Error ? error.message : String(error)}`, {
            cause: error,
        });
    } finally {
        fs.closeSync(fd);
    }
}

/** A newer installed application may already have migrated the profile; never downgrade it implicitly. */
export function assertNoDowngrade(installed: unknown, target: string): void {
    if (typeof installed !== "string" || !/^\d+\.\d+\.\d+$/.test(installed) || !/^\d+\.\d+\.\d+$/.test(target)) {
        throw new Error("Version installée ou cible non reconnue. Aucun remplacement automatique effectué.");
    }
    const current = installed.split(".").map(BigInt);
    const next = target.split(".").map(BigInt);
    for (let i = 0; i < 3; i++) {
        if (current[i] > next[i]) {
            throw new Error(
                `Element ${installed} est plus récent que ${target}. Retour en arrière automatique refusé.`,
            );
        }
        if (current[i] < next[i]) return;
    }
}

function appInfo(app: string): Record<string, unknown> {
    return record(
        JSON.parse(command("/usr/bin/plutil", ["-convert", "json", "-o", "-", path.join(app, "Contents/Info.plist")])),
    );
}

function verifyApp(app: string, version?: string): void {
    if (!fs.lstatSync(app).isDirectory()) throw new Error(`Bundle réel attendu : ${app}`);
    command("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
    const info = appInfo(app);
    if (info.CFBundleIdentifier !== "im.riot.app" || info.CFBundleExecutable !== "Element") {
        throw new Error(`Identité d’application inattendue : ${app}`);
    }
    if (version) {
        assertNoDowngrade(appInfo(APP).CFBundleShortVersionString, version);
        if (info.CFBundleShortVersionString !== version)
            throw new Error("La version du bundle diffère de la livraison.");
        const metadata = readAsarPackage(path.join(app, "Contents/Resources/app.asar"));
        if (
            metadata.electron_manual_updates !== true ||
            metadata.productName !== "Element" ||
            metadata.electron_appId !== "im.riot.app" ||
            metadata.version !== version
        ) {
            throw new Error("Le bundle ne correspond pas au fork avec mises à jour officielles désactivées.");
        }
    }
}

/** Check the supported existing Mac installation before spending time on a build. */
export function preflightMacInstall(): void {
    if (process.platform !== "darwin" || process.arch !== "arm64") {
        throw new Error("L’installation automatique est prévue pour votre Mac Apple Silicon.");
    }
    for (const directory of [APP, PROTON]) {
        if (!fs.lstatSync(directory).isDirectory()) {
            throw new Error(`Application manquante ou lien symbolique : ${directory}`);
        }
    }
    if (fs.existsSync(PROFILE) && !fs.lstatSync(PROFILE).isDirectory()) {
        throw new Error("Le profil Element doit être un dossier réel.");
    }
    fs.accessSync(path.dirname(APP), fs.constants.W_OK);
    for (const processLine of elementProcesses(processes())) {
        if (!processLine.startsWith(`${APP}/Contents/`) || /(?:^| )--profile(?:-dir)?(?:[ =]|$)/.test(processLine)) {
            throw new Error(
                "Une autre copie ou un profil personnalisé d’Element est ouvert. Quittez-le avant cette installation.",
            );
        }
    }
}

/** Injectable native boundary keeps process-control tests away from the user's running application. */
export interface MacRuntime {
    command: (binary: string, args: string[], timeout?: number) => string;
    processes: () => string[];
    now: () => number;
    wait: (milliseconds: number) => Promise<void>;
}

const nativeRuntime: MacRuntime = { command, processes, now: Date.now, wait: delay };

/** Quit gracefully with one overall deadline, including the Apple event, and never terminate a process forcibly. */
export async function quitElement(runtime: MacRuntime = nativeRuntime): Promise<void> {
    const deadline = runtime.now() + 45_000;
    if (!elementProcesses(runtime.processes()).length) return;
    try {
        runtime.command(
            "/usr/bin/osascript",
            [
                "-e",
                `with timeout of 10 seconds\nif application "${APP}" is running then\ntell application "${APP}" to quit\nend if\nend timeout`,
            ],
            Math.max(1, Math.min(15_000, deadline - runtime.now())),
        );
    } catch {
        // A confirmation dialog can outlast the Apple event timeout. Never force termination.
    }
    while (runtime.now() < deadline) {
        if (!elementProcesses(runtime.processes()).length) return;
        await runtime.wait(Math.min(500, Math.max(0, deadline - runtime.now())));
    }
    throw new Error(
        "Element n’a pas quitté. Validez sa demande de fermeture, puis relancez le script. Aucun remplacement effectué.",
    );
}

/** Require every expected flag exactly once, with argument boundaries, so conflicting overrides fail closed. */
export function hasProtonArguments(line: string): boolean {
    return [PROXY, RESOLVER, WEBRTC].every((flag) => {
        const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const key = flag.slice(0, flag.indexOf("="));
        return (
            new RegExp(`(?:^| )${escaped}(?= |$)`).test(line) &&
            (line.match(new RegExp(`(?:^| )${key}(?:=| |$)`, "g"))?.length ?? 0) === 1
        );
    });
}

/** Repair incomplete launch arguments, then open only the existing Proton launcher and verify the result. */
export async function launchViaProton(runtime: MacRuntime = nativeRuntime): Promise<void> {
    const running = mainProcesses(runtime.processes());
    if (running.length && (running.length !== 1 || !hasProtonArguments(running[0]))) await quitElement(runtime);
    const deadline = runtime.now() + 45_000;
    runtime.command("/usr/bin/open", [PROTON], 10_000);
    let stableSince: number | undefined;
    while (runtime.now() < deadline) {
        const main = mainProcesses(runtime.processes());
        if (main.length === 1 && hasProtonArguments(main[0])) {
            stableSince ??= runtime.now();
            if (runtime.now() - stableSince >= 3_000) return;
        } else {
            stableSince = undefined;
        }
        await runtime.wait(500);
    }
    throw new Error(
        "Le lancement via Proton n’a pas été confirmé. Vérifiez Element (Proton), le tunnel et toute demande macOS, puis relancez le script.",
    );
}

function logicalBytes(filename: string): bigint {
    try {
        const stat = fs.lstatSync(filename, { bigint: true });
        if (stat.isSymbolicLink()) return 4_096n;
        if (stat.isDirectory()) {
            return fs
                .readdirSync(filename)
                .reduce((size, entry) => size + logicalBytes(path.join(filename, entry)), 4_096n);
        }
        return stat.size + 4_096n;
    } catch (error) {
        // This estimate runs before quit; profile caches and logs can disappear during traversal.
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0n;
        throw error;
    }
}

function checkInstallSpace(sourceApp: string): void {
    let backupParent = BACKUPS;
    while (!fs.existsSync(backupParent)) backupParent = path.dirname(backupParent);
    const allocations: [string, bigint][] = [
        [path.dirname(APP), logicalBytes(sourceApp)],
        [backupParent, logicalBytes(APP) + (fs.existsSync(PROFILE) ? logicalBytes(PROFILE) : 0n)],
    ];
    const volumes = new Map<bigint, { directory: string; bytes: bigint }>();
    for (const [directory, bytes] of allocations) {
        const device = fs.statSync(directory, { bigint: true }).dev;
        const volume = volumes.get(device);
        if (volume) volume.bytes += bytes;
        else volumes.set(device, { directory, bytes });
    }
    for (const { directory, bytes } of volumes.values()) {
        const space = fs.statfsSync(directory, { bigint: true });
        const required = bytes + 512n * 1024n * 1024n;
        if (space.bavail * space.bsize < required) {
            throw new Error(
                `Espace libre insuffisant pour préparer l’application et sa sauvegarde sur ${directory}. Libérez au moins ${Number(required / (1024n * 1024n))} Mio, puis réessayez.`,
            );
        }
    }
}

const macHost: InstallHost = {
    preflight: preflightMacInstall,
    verify: verifyApp,
    copy: (source, destination) => {
        command("/usr/bin/ditto", ["--rsrc", "--extattr", source, destination], 300_000);
    },
    assertStopped,
    quit: quitElement,
    launch: launchViaProton,
    stage: (dmg, destination) => {
        const mount = fs.mkdtempSync(path.join(os.tmpdir(), "element-menubar-mount-"));
        let attached = false;
        try {
            command("/usr/bin/hdiutil", ["attach", dmg, "-readonly", "-nobrowse", "-mountpoint", mount], 120_000);
            attached = true;
            checkInstallSpace(path.join(mount, "Element.app"));
            command("/usr/bin/ditto", ["--rsrc", "--extattr", path.join(mount, "Element.app"), destination], 300_000);
        } finally {
            // Never recursively remove a mountpoint if detaching fails.
            if (attached) command("/usr/bin/hdiutil", ["detach", mount], 60_000);
            fs.rmdirSync(mount);
        }
    },
};

/** Back up and replace the existing Element installation, then use the user's unchanged Proton launcher. */
export async function installOnMac(directory: string): Promise<void> {
    await installDelivery(directory, { app: APP, profile: PROFILE, backupRoot: BACKUPS, host: macHost });
}
