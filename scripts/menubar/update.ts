/*
Copyright 2026 o-Oby

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";

const BRANCH = "codex/macos-menubar";
const RELEASE_FILE = "menubar/release.json";
const ORIGIN = "https://github.com/o-Oby/element-menubar.git";
const UPSTREAM = "https://github.com/element-hq/element-web.git";

/** Dependencies can be supplied by the fixture tests without contacting GitHub or building Electron. */
export interface UpdateOptions {
    repository: string;
    latestRelease?: () => Promise<string>;
    build?: (candidate: string, logFile: string) => Promise<void>;
    openDirectory?: (directory: string) => void;
    log?: (message: string) => void;
    expectedOrigin?: string;
    expectedUpstream?: string;
}

interface ForkRelease {
    upstreamTag: string;
    revision: number;
}

interface Delivery extends ForkRelease {
    sourceCommit: string;
    builtAt: string;
    artifacts: { name: string; sha256: string }[];
}

function git(repository: string, ...args: string[]): string {
    try {
        return execFileSync("git", ["-C", repository, ...args], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
            maxBuffer: 16 * 1024 * 1024,
        }).trim();
    } catch (error) {
        const detail = error as Error & { stderr?: Buffer | string };
        throw new Error(`git ${args.join(" ")} : ${String(detail.stderr ?? detail.message).trim()}`, { cause: error });
    }
}

function cleanRepository(repository: string, expectedHead?: string): string {
    if (git(repository, "branch", "--show-current") !== BRANCH) {
        throw new Error(`Ouvrez la branche ${BRANCH} avant de lancer la mise à jour.`);
    }
    if (git(repository, "status", "--porcelain", "--untracked-files=normal")) {
        throw new Error("Le dépôt contient des modifications non enregistrées. Enregistrez-les avant la mise à jour.");
    }
    const head = git(repository, "rev-parse", "HEAD");
    if (expectedHead && head !== expectedHead) {
        throw new Error("La branche a changé pendant la préparation. La livraison n’a pas été appliquée.");
    }
    return head;
}

function normaliseRemote(url: string): string {
    return url
        .replace(/^git@github\.com:/, "https://github.com/")
        .replace(/\.git$/, "")
        .replace(/\/$/, "");
}

function checkRemote(repository: string, name: string, expected: string): void {
    const urls = [git(repository, "remote", "get-url", "--all", name)];
    if (name === "origin") urls.push(git(repository, "remote", "get-url", "--push", "--all", name));
    if (urls.some((url) => normaliseRemote(url) !== normaliseRemote(expected))) {
        throw new Error(`Le remote ${name} doit désigner ${expected}. Aucun dépôt distant n’a été modifié.`);
    }
}

function assertTag(tag: unknown): asserts tag is string {
    if (typeof tag !== "string" || !/^v\d+\.\d+\.\d+$/.test(tag)) {
        throw new Error("La version officielle reçue n’est pas une version stable reconnue (vX.Y.Z).");
    }
}

function readRelease(repository: string): ForkRelease {
    const release = JSON.parse(fs.readFileSync(path.join(repository, RELEASE_FILE), "utf8")) as ForkRelease;
    assertTag(release.upstreamTag);
    if (!Number.isSafeInteger(release.revision) || release.revision < 1) {
        throw new Error("La révision du fork dans menubar/release.json est invalide.");
    }
    return release;
}

function compareVersions(a: string, b: string): number {
    const partsA = a.slice(1).split(".").map(BigInt);
    const partsB = b.slice(1).split(".").map(BigInt);
    for (let i = 0; i < 3; i++) {
        if (partsA[i] > partsB[i]) return 1;
        if (partsA[i] < partsB[i]) return -1;
    }
    return 0;
}

async function latestStableRelease(): Promise<string> {
    const response = await fetch("https://api.github.com/repos/element-hq/element-web/releases/latest", {
        headers: { "Accept": "application/vnd.github+json", "User-Agent": "Element-Menu-Bar-Updater" },
        signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok)
        throw new Error(`GitHub ne répond pas correctement (HTTP ${response.status}). Réessayez plus tard.`);
    const release = (await response.json()) as { tag_name?: unknown; draft?: boolean; prerelease?: boolean };
    if (release.draft || release.prerelease) throw new Error("GitHub n’a pas renvoyé une version stable publiée.");
    assertTag(release.tag_name);
    return release.tag_name;
}

function sha256(filename: string): string {
    return createHash("sha256").update(fs.readFileSync(filename)).digest("hex");
}

function deliveryPath(repository: string, release: ForkRelease): string {
    return path.join(repository, "dist", "menubar", `${release.upstreamTag}-r${release.revision}`);
}

function readDelivery(directory: string): Delivery | undefined {
    try {
        return JSON.parse(fs.readFileSync(path.join(directory, "release.json"), "utf8")) as Delivery;
    } catch {
        return undefined;
    }
}

function hasValidDelivery(directory: string, release: ForkRelease, head: string): boolean {
    const delivery = readDelivery(directory);
    if (
        !delivery ||
        delivery.sourceCommit !== head ||
        delivery.upstreamTag !== release.upstreamTag ||
        delivery.revision !== release.revision ||
        !Array.isArray(delivery.artifacts) ||
        !delivery.artifacts.some((artifact) => typeof artifact?.name === "string" && artifact.name.endsWith(".dmg"))
    ) {
        return false;
    }
    try {
        return delivery.artifacts.every(
            (artifact) =>
                typeof artifact.name === "string" &&
                path.basename(artifact.name) === artifact.name &&
                /^[a-f0-9]{64}$/.test(artifact.sha256) &&
                fs.lstatSync(path.join(directory, artifact.name)).isFile() &&
                sha256(path.join(directory, artifact.name)) === artifact.sha256,
        );
    } catch {
        return false;
    }
}

async function buildCandidate(candidate: string, logFile: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const child = spawn("bash", ["scripts/menubar/build.sh"], {
            cwd: candidate,
            stdio: ["ignore", "pipe", "pipe"],
            env: { ...process.env, CI: "1" },
        });
        child.stdout.on("data", (data: Buffer) => {
            fs.appendFileSync(logFile, data);
            process.stdout.write(data);
        });
        child.stderr.on("data", (data: Buffer) => {
            fs.appendFileSync(logFile, data);
            process.stderr.write(data);
        });
        child.on("error", reject);
        child.on("close", (code) => {
            if (code === 0) resolve();
            else reject(new Error(`La compilation a échoué (code ${code}). Voir ${logFile}`));
        });
    });
}

function copyDelivery(candidate: string, destination: string, release: ForkRelease, head: string): void {
    const output = path.join(candidate, "apps", "desktop", "dist");
    const files = fs.readdirSync(output).filter((filename) => filename.endsWith(".dmg"));
    if (!files.length) throw new Error("La compilation n’a produit aucun fichier DMG.");
    fs.mkdirSync(destination, { recursive: true });
    const artifacts = files.map((name) => {
        const source = path.join(output, name);
        if (!fs.lstatSync(source).isFile()) throw new Error(`L’artefact ${name} n’est pas un fichier ordinaire.`);
        const target = path.join(destination, name);
        fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
        return { name, sha256: sha256(target) };
    });
    const manifest: Delivery = { ...release, sourceCommit: head, builtAt: new Date().toISOString(), artifacts };
    fs.writeFileSync(path.join(destination, "release.json"), `${JSON.stringify(manifest, null, 4)}\n`);
    fs.writeFileSync(
        path.join(destination, "SHA256SUMS"),
        artifacts.map((artifact) => `${artifact.sha256}  ${artifact.name}\n`).join(""),
    );
}

function fetchOrigin(repository: string, expectedHead: string): void {
    git(repository, "fetch", "--no-tags", "origin", `refs/heads/${BRANCH}`);
    if (git(repository, "rev-parse", "FETCH_HEAD") !== expectedHead) {
        throw new Error("Le fork GitHub et la branche locale diffèrent. Synchronisez-les avant de relancer le script.");
    }
}

/** Prepare and publish a tested source revision, then expose its DMG without installing or touching app profiles. */
export async function runUpdate(options: UpdateOptions): Promise<string> {
    const repository = fs.realpathSync(options.repository);
    if (fs.realpathSync(git(repository, "rev-parse", "--show-toplevel")) !== repository) {
        throw new Error("Lancez le script depuis la racine du fork Element Menu Bar.");
    }
    const commonDir = path.resolve(repository, git(repository, "rev-parse", "--git-common-dir"));
    const stateDir = path.join(commonDir, "menubar-updates");
    fs.mkdirSync(stateDir, { recursive: true });
    const lock = path.join(stateDir, "lock");
    try {
        fs.mkdirSync(lock);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        throw new Error(`Une préparation est déjà en cours. Si elle a été interrompue, consultez ${lock}.`);
    }
    const log = options.log ?? console.log;
    const openDirectory =
        options.openDirectory ??
        ((directory: string): void => {
            execFileSync("open", [directory], { stdio: "ignore" });
        });
    const showDelivery = (directory: string): void => {
        try {
            openDirectory(directory);
        } catch {
            log(`Le Finder n’a pas pu être ouvert. La livraison reste disponible dans : ${directory}`);
        }
    };
    let runDir: string | undefined;
    try {
        fs.writeFileSync(
            path.join(lock, "owner.json"),
            JSON.stringify({ pid: process.pid, started: new Date().toISOString() }),
        );
        const head = cleanRepository(repository);
        checkRemote(repository, "origin", options.expectedOrigin ?? ORIGIN);
        checkRemote(repository, "upstream", options.expectedUpstream ?? UPSTREAM);
        fetchOrigin(repository, head);
        const release = readRelease(repository);
        log("Recherche de la dernière version stable officielle…");
        const targetTag = await (options.latestRelease ?? latestStableRelease)();
        assertTag(targetTag);
        if (compareVersions(targetTag, release.upstreamTag) < 0) {
            throw new Error(
                "La version annoncée est plus ancienne que celle du fork. Aucun retour en arrière effectué.",
            );
        }
        if (targetTag === release.upstreamTag && hasValidDelivery(deliveryPath(repository, release), release, head)) {
            const directory = deliveryPath(repository, release);
            log(`La version ${targetTag}, révision ${release.revision}, est déjà préparée.`);
            showDelivery(directory);
            return directory;
        }

        const runId = `${Date.now()}-${process.pid}`;
        runDir = path.join(stateDir, runId);
        fs.mkdirSync(runDir);
        const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "element-menubar-update-"));
        const candidate = path.join(workspaceRoot, "worktree");
        const candidateBranch = `codex/menubar-update/${runId}`;
        const logFile = path.join(runDir, "build.log");
        fs.writeFileSync(logFile, `Base: ${head}\nVersion cible: ${targetTag}\nPréparation: ${candidate}\n`);
        fs.writeFileSync(
            path.join(runDir, "preparation.json"),
            `${JSON.stringify({ candidate, candidateBranch, head, targetTag }, null, 4)}\n`,
        );
        log(`Préparation isolée : ${candidate}`);
        git(repository, "worktree", "add", "-b", candidateBranch, candidate, head);
        if (targetTag !== release.upstreamTag) {
            git(candidate, "fetch", "--no-tags", "upstream", `refs/tags/${targetTag}`);
            const upstreamHead = git(candidate, "rev-parse", "FETCH_HEAD^{commit}");
            git(candidate, "merge", "--no-ff", "--no-edit", upstreamHead);
        }
        const previousDelivery = readDelivery(deliveryPath(repository, release));
        const nextRelease: ForkRelease = {
            upstreamTag: targetTag,
            revision: targetTag !== release.upstreamTag ? 1 : release.revision,
        };
        if (targetTag === release.upstreamTag && previousDelivery && previousDelivery.sourceCommit !== head) {
            nextRelease.revision++;
        }
        if (JSON.stringify(nextRelease) !== JSON.stringify(release)) {
            fs.writeFileSync(path.join(candidate, RELEASE_FILE), `${JSON.stringify(nextRelease, null, 4)}\n`);
            git(candidate, "add", RELEASE_FILE);
            git(candidate, "commit", "-m", `Prepare Element Menu Bar ${targetTag} revision ${nextRelease.revision}`);
        }
        const candidateHead = git(candidate, "rev-parse", "HEAD");
        fs.appendFileSync(logFile, `Source: ${candidateHead}\n`);
        log("Vérifications et construction du DMG…");
        await (options.build ?? buildCandidate)(candidate, logFile);
        if (git(candidate, "rev-parse", "HEAD") !== candidateHead) {
            throw new Error("La construction a changé le commit préparé. La livraison n’a pas été appliquée.");
        }
        if (git(candidate, "status", "--porcelain", "--untracked-files=normal")) {
            throw new Error("La construction a modifié les sources suivies ou créé des fichiers non ignorés.");
        }
        const deliveryRoot = path.join(repository, "dist", "menubar");
        const stagedDelivery = path.join(deliveryRoot, `.preparation-${runId}`);
        copyDelivery(candidate, stagedDelivery, nextRelease, candidateHead);
        cleanRepository(repository, head);
        checkRemote(repository, "origin", options.expectedOrigin ?? ORIGIN);
        fetchOrigin(repository, head);
        log("Publication des sources validées dans votre fork GitHub…");
        git(repository, "push", "origin", `${candidateHead}:refs/heads/${BRANCH}`);
        cleanRepository(repository, head);
        git(repository, "merge", "--ff-only", candidateHead);
        const destination = deliveryPath(repository, nextRelease);
        if (fs.existsSync(destination)) fs.renameSync(destination, `${destination}-previous-${runId}`);
        fs.renameSync(stagedDelivery, destination);
        fs.writeFileSync(
            path.join(runDir, "delivery.json"),
            `${JSON.stringify({ destination, candidateHead }, null, 4)}\n`,
        );
        git(repository, "worktree", "remove", candidate);
        fs.rmdirSync(workspaceRoot);
        git(repository, "branch", "-d", candidateBranch);
        log(`Prêt : ${destination}\nQuittez Element Menu Bar, puis installez le DMG. Votre profil sera conservé.`);
        showDelivery(destination);
        return destination;
    } catch (error) {
        const details = error instanceof Error ? error.message : String(error);
        if (runDir) {
            fs.appendFileSync(path.join(runDir, "build.log"), `\nÉCHEC : ${details}\n`);
            throw new Error(`${details}\nPréparation et diagnostic conservés dans : ${runDir}`, { cause: error });
        }
        throw error;
    } finally {
        fs.rmSync(lock, { recursive: true, force: true });
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    runUpdate({ repository: path.resolve(import.meta.dirname, "../..") }).catch((error: unknown) => {
        console.error(`\nMise à jour interrompue : ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
    });
}
