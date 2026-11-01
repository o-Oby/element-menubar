/*
Copyright 2026 o-Oby

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import path from "node:path";

/** macOS operations are injected so transaction tests never touch the installed application. */
export interface InstallHost {
    preflight: () => void;
    stage: (dmg: string, destination: string) => void;
    verify: (app: string, version?: string) => void;
    copy: (source: string, destination: string) => void;
    quit: () => Promise<void>;
    assertStopped: () => void;
    launch: () => Promise<void>;
}

/** All private backups stay outside the source repository. */
export interface InstallOptions {
    app: string;
    profile: string;
    backupRoot: string;
    host: InstallHost;
    log?: (message: string) => void;
}

function sha256(filename: string): string {
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(1024 * 1024);
    const fd = fs.openSync(filename, "r");
    try {
        let length: number;
        while ((length = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
            hash.update(buffer.subarray(0, length));
        }
    } finally {
        fs.closeSync(fd);
    }
    return hash.digest("hex");
}

/** Hash files and links without following symlinks, including executable permissions and empty directories. */
export function treeDigest(directory: string): string {
    const hash = createHash("sha256");
    const visit = (relative: string): void => {
        const target = path.join(directory, relative);
        const stat = fs.lstatSync(target);
        if (stat.isSymbolicLink()) {
            hash.update(JSON.stringify([relative, "link", fs.readlinkSync(target)]));
        } else if (stat.isDirectory()) {
            hash.update(JSON.stringify([relative, "directory", stat.mode & 0o777]));
            for (const entry of fs.readdirSync(target).sort()) visit(path.join(relative, entry));
        } else if (stat.isFile()) {
            hash.update(JSON.stringify([relative, "file", stat.mode & 0o777, sha256(target)]));
        } else {
            throw new Error(`Fichier spécial impossible à sauvegarder de façon cohérente : ${target}`);
        }
    };
    visit("");
    return hash.digest("hex");
}

function directoryExists(directory: string): boolean {
    try {
        if (!fs.lstatSync(directory).isDirectory()) throw new Error(`Dossier réel attendu : ${directory}`);
        return true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
    }
}

function writeJSON(filename: string, value: unknown): void {
    fs.writeFileSync(filename, `${JSON.stringify(value, null, 4)}\n`, { mode: 0o600 });
}

/** Install a verified delivery, with a closed-profile backup and rollback before the first launch. */
export async function installDelivery(directory: string, options: InstallOptions): Promise<void> {
    const { app, profile, backupRoot, host } = options;
    const log = options.log ?? console.log;
    host.preflight();
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, "release.json"), "utf8")) as {
        upstreamTag: string;
        revision: number;
        sourceCommit: string;
        artifacts: { name: string; sha256: string }[];
    };
    if (
        !/^v\d+\.\d+\.\d+$/.test(manifest.upstreamTag) ||
        !Number.isSafeInteger(manifest.revision) ||
        manifest.revision < 1 ||
        !/^[a-f0-9]{40}$/.test(manifest.sourceCommit) ||
        !Array.isArray(manifest.artifacts)
    ) {
        throw new Error("Manifeste de livraison invalide. Installation annulée.");
    }
    const name = `Element-Menu-Bar-${manifest.upstreamTag.slice(1)}-r${manifest.revision}-arm64.dmg`;
    const artifact = manifest.artifacts.find((entry) => entry.name === name);
    const dmg = path.join(directory, name);
    if (
        !artifact ||
        !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
        !fs.lstatSync(dmg).isFile() ||
        sha256(dmg) !== artifact.sha256
    ) {
        throw new Error("L’empreinte du DMG ne correspond pas à la livraison. Installation annulée.");
    }
    const staging = fs.mkdtempSync(path.join(path.dirname(app), ".element-menubar-install-"));
    fs.chmodSync(staging, 0o700);
    const stagedApp = path.join(staging, "Element.app");
    const previousApp = path.join(staging, "Element.previous");
    let backup: string | undefined;
    let installed = false;
    let launching = false;
    let keepStaging = false;
    try {
        log("Vérification du DMG et préparation de l’installation…");
        host.stage(dmg, stagedApp);
        host.verify(stagedApp, manifest.upstreamTag.slice(1));
        const targetDigest = treeDigest(stagedApp);
        host.verify(app);
        if (treeDigest(app) === targetDigest) {
            log("Cette version est déjà installée. Vérification du lancement via Proton…");
            await host.launch();
            return;
        }

        log("Fermeture d’Element… Si une confirmation apparaît, validez Quitter.");
        await host.quit();
        host.assertStopped();
        if (directoryExists(backupRoot)) fs.chmodSync(backupRoot, 0o700);
        else fs.mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
        backup = fs.mkdtempSync(path.join(backupRoot, `${new Date().toISOString().replace(/[:.]/g, "-")}-`));
        fs.chmodSync(backup, 0o700);
        log(`Sauvegarde privée de l’application et du profil : ${backup}`);
        writeJSON(path.join(backup, "installation.json"), { status: "backing-up", delivery: directory, ...manifest });
        const appDigest = treeDigest(app);
        const profileExisted = directoryExists(profile);
        const profileDigest = profileExisted ? treeDigest(profile) : null;
        host.copy(app, path.join(backup, "Element.app"));
        if (profileExisted) host.copy(profile, path.join(backup, "profile-Element"));
        host.assertStopped();
        if (
            treeDigest(path.join(backup, "Element.app")) !== appDigest ||
            treeDigest(app) !== appDigest ||
            (profileExisted &&
                (treeDigest(path.join(backup, "profile-Element")) !== profileDigest ||
                    treeDigest(profile) !== profileDigest)) ||
            (!profileExisted && fs.existsSync(profile))
        ) {
            throw new Error("La sauvegarde ne correspond pas aux données arrêtées. Aucun remplacement effectué.");
        }
        host.verify(path.join(backup, "Element.app"));
        writeJSON(path.join(backup, "backup.json"), {
            createdAt: new Date().toISOString(),
            app,
            profile,
            profileExisted,
            appDigest,
            profileDigest,
            verified: true,
        });
        fs.writeFileSync(
            path.join(backup, "RESTAURATION.txt"),
            "Quittez complètement Element avant toute restauration.\n" +
                "Conservez à part l’application et le profil actuels, sans fusionner les bases de données.\n" +
                `Restaurez Element.app depuis cette sauvegarde vers ${app}.\n` +
                (profileExisted
                    ? `Restaurez le dossier profile-Element complet vers ${profile}.\n`
                    : `Aucun profil n’existait : conservez à part tout nouveau dossier ${profile}.\n`) +
                "Relancez exclusivement /Applications/Element (Proton).app.\n" +
                "Le trousseau macOS n’a pas été exporté ni modifié.\n",
            { mode: 0o600 },
        );
        // Both renames stay on the same filesystem. The original remains available until launch succeeds.
        host.assertStopped();
        fs.renameSync(app, previousApp);
        fs.renameSync(stagedApp, app);
        installed = true;
        host.verify(app, manifest.upstreamTag.slice(1));
        if (treeDigest(app) !== targetDigest) throw new Error("Le bundle installé diffère du bundle préparé.");
        host.assertStopped();
        writeJSON(path.join(backup, "installation.json"), { status: "installed", delivery: directory, ...manifest });
        launching = true;
        log("Relance d’Element via votre lanceur Proton…");
        await host.launch();
        writeJSON(path.join(backup, "installation.json"), {
            status: "launched-via-proton",
            completedAt: new Date().toISOString(),
            delivery: directory,
            ...manifest,
        });
        log(`Mise à jour terminée. Element est lancé via Proton.\nSauvegarde conservée : ${backup}`);
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        let recovery = "";
        if (!launching && fs.existsSync(previousApp)) {
            try {
                host.assertStopped();
                if (installed) fs.renameSync(app, path.join(staging, "Element.failed"));
                fs.renameSync(previousApp, app);
                recovery = "L’application précédente a été remise en place. Le profil n’a pas été modifié.";
            } catch (rollbackError) {
                keepStaging = true;
                recovery = `Restauration à terminer manuellement : ${String(rollbackError)}. Original : ${previousApp}`;
            }
        } else if (launching) {
            recovery =
                "Le lancement n’a pas pu être confirmé. Application et profil actuels conservés ; " +
                "aucune restauration automatique après lancement. Consultez RESTAURATION.txt dans la sauvegarde.";
        }
        if (backup) {
            try {
                writeJSON(path.join(backup, "installation.json"), { status: "failed", detail, recovery, ...manifest });
            } catch {
                recovery += "\nLe diagnostic n’a pas pu être écrit sur disque ; conservez ce message.";
            }
        }
        throw new Error(`${detail}\n${recovery}${backup ? `\nSauvegarde et diagnostic : ${backup}` : ""}`, {
            cause: error,
        });
    } finally {
        if (!keepStaging) {
            try {
                fs.rmSync(staging, { recursive: true, force: true });
            } catch {
                log(`Dossier temporaire à nettoyer après vérification : ${staging}`);
            }
        }
    }
}
