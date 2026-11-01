/*
Copyright 2026 o-Oby

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runUpdate, type UpdateOptions } from "./update.ts";

const BRANCH = "codex/macos-menubar";
const cleanups: (() => void)[] = [];

function git(directory: string, ...args: string[]): string {
    return execFileSync("git", ["-C", directory, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
    }).trim();
}

function put(directory: string, filename: string, contents: string): void {
    const target = path.join(directory, filename);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
}

function commit(directory: string, message: string): void {
    git(directory, "add", ".");
    git(directory, "commit", "-m", message);
}

function configureGit(directory: string): void {
    git(directory, "config", "user.name", "Element Menu Bar Test");
    git(directory, "config", "user.email", "test@example.invalid");
}

function fixture(): {
    repository: string;
    seed: string;
    remote: string;
    upstream: string;
    head: string;
    options: UpdateOptions;
    publishUpstream: (conflict?: boolean) => void;
} {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "element-menubar-fixture-"));
    const seed = path.join(directory, "seed");
    const upstream = path.join(directory, "upstream.git");
    const remote = path.join(directory, "fork.git");
    const repository = path.join(directory, "repo with spaces");
    fs.mkdirSync(seed);
    git(seed, "init", "-b", "develop");
    configureGit(seed);
    put(seed, ".gitignore", "dist/\n");
    put(seed, "upstream.txt", "upstream base\n");
    commit(seed, "Initial official version");
    git(seed, "tag", "v1.0.0");
    git(directory, "clone", "--bare", seed, upstream);
    git(directory, "init", "--bare", remote);
    git(directory, "clone", upstream, repository);
    configureGit(repository);
    git(repository, "remote", "rename", "origin", "upstream");
    git(repository, "remote", "add", "origin", remote);
    git(repository, "checkout", "-b", BRANCH, "v1.0.0");
    put(repository, "menubar/release.json", JSON.stringify({ upstreamTag: "v1.0.0", revision: 1 }));
    put(repository, "fork.txt", "retain this customization\n");
    commit(repository, "Add menu bar customization");
    git(repository, "push", "origin", BRANCH);
    const head = git(repository, "rev-parse", "HEAD");
    const publishUpstream = (conflict = false): void => {
        put(seed, "upstream.txt", conflict ? "official changed line\n" : "official v1.1.0\n");
        commit(seed, "Release official update");
        git(seed, "tag", "v1.1.0");
        git(seed, "push", upstream, "develop", "--tags");
    };
    const options: UpdateOptions = {
        repository,
        expectedOrigin: remote,
        expectedUpstream: upstream,
        latestRelease: async () => "v1.1.0",
        build: async (candidate): Promise<void> => {
            assert.ok(!candidate.includes(" "), "native modules require a no-space build directory");
            assert.equal(fs.readFileSync(path.join(candidate, "fork.txt"), "utf8"), "retain this customization\n");
            put(candidate, "apps/desktop/dist/Element-Menu-Bar.dmg", "test disk image\n");
        },
        openDirectory: () => {},
        log: () => {},
    };
    cleanups.push(() => {
        const worktrees = git(repository, "worktree", "list", "--porcelain")
            .split("\n")
            .filter((line) => line.startsWith("worktree "))
            .map((line) => line.slice(9));
        for (const worktree of worktrees) {
            if (
                worktree !== repository &&
                path.basename(path.dirname(worktree)).startsWith("element-menubar-update-")
            ) {
                fs.rmSync(path.dirname(worktree), { recursive: true, force: true });
            }
        }
        fs.rmSync(directory, { recursive: true, force: true });
    });
    return { repository, seed, remote, upstream, head, options, publishUpstream };
}

function assertUnchanged(f: ReturnType<typeof fixture>, expectedHead = f.head): void {
    assert.equal(git(f.repository, "rev-parse", "HEAD"), expectedHead);
    assert.equal(git(f.remote, "rev-parse", `refs/heads/${BRANCH}`), expectedHead);
    assert.equal(git(f.repository, "status", "--porcelain"), "");
}

afterEach(() => {
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

void describe("Element Menu Bar source update", () => {
    void it("should merge a stable version, preserve fork changes, publish tested sources and retain the DMG", async () => {
        const f = fixture();
        f.publishUpstream();
        const destination = await runUpdate(f.options);
        const head = git(f.repository, "rev-parse", "HEAD");
        assert.notEqual(head, f.head);
        assertUnchanged(f, head);
        assert.equal(fs.readFileSync(path.join(f.repository, "upstream.txt"), "utf8"), "official v1.1.0\n");
        assert.equal(fs.readFileSync(path.join(f.repository, "fork.txt"), "utf8"), "retain this customization\n");
        const manifest = JSON.parse(fs.readFileSync(path.join(destination, "release.json"), "utf8"));
        assert.equal(manifest.sourceCommit, head);
        assert.equal(manifest.upstreamTag, "v1.1.0");
        assert.equal(manifest.revision, 1);
        assert.match(
            fs.readFileSync(path.join(destination, "SHA256SUMS"), "utf8"),
            /^[a-f0-9]{64} {2}Element-Menu-Bar.dmg\n$/,
        );
        assert.equal(git(f.repository, "worktree", "list", "--porcelain").match(/^worktree /gm)?.length, 1);
    });

    void it("should build a missing same-version artifact, then reuse only its verified delivery", async () => {
        const f = fixture();
        f.options.latestRelease = async () => "v1.0.0";
        let builds = 0;
        const originalBuild = f.options.build!;
        f.options.build = async (...args): Promise<void> => {
            builds++;
            await originalBuild(...args);
        };
        const destination = await runUpdate(f.options);
        assert.equal(builds, 1);
        assertUnchanged(f);
        assert.equal(await runUpdate(f.options), destination);
        assert.equal(builds, 1);
        put(destination, "Element-Menu-Bar.dmg", "corrupted artifact");
        assert.equal(await runUpdate(f.options), destination);
        assert.equal(builds, 2);
    });

    void it("should keep the lock during installation, and retry a failed install using the existing delivery", async () => {
        const f = fixture();
        f.options.latestRelease = async () => "v1.0.0";
        const build = f.options.build!;
        let builds = 0;
        let installs = 0;
        f.options.build = async (...args) => {
            builds++;
            await build(...args);
        };
        f.options.install = async (directory) => {
            installs++;
            assert.ok(fs.existsSync(path.join(directory, "release.json")));
            assert.ok(fs.existsSync(path.join(f.repository, ".git/menubar-updates/lock")));
            if (installs === 1) throw new Error("installation failed");
        };
        await assert.rejects(runUpdate(f.options), /installation failed/);
        await runUpdate(f.options);
        assert.equal(builds, 1);
        assert.equal(installs, 2);
        assert.equal(fs.existsSync(path.join(f.repository, ".git/menubar-updates/lock")), false);
        assertUnchanged(f);
    });

    void it("should create a new fork revision for changed customizations and tolerate unavailable Finder", async () => {
        const f = fixture();
        f.options.latestRelease = async () => "v1.0.0";
        const originalDestination = await runUpdate(f.options);
        put(f.repository, "new-customization.txt", "another menu bar improvement");
        commit(f.repository, "Improve the fork");
        git(f.repository, "push", "origin", BRANCH);
        f.options.openDirectory = () => {
            throw new Error("Finder is unavailable");
        };
        const nextDestination = await runUpdate(f.options);
        assert.notEqual(nextDestination, originalDestination);
        assert.ok(fs.existsSync(originalDestination));
        const release = JSON.parse(fs.readFileSync(path.join(f.repository, "menubar/release.json"), "utf8"));
        assert.deepEqual(release, { upstreamTag: "v1.0.0", revision: 2 });
        assertUnchanged(f, git(f.repository, "rev-parse", "HEAD"));
    });

    void it("should stop on a merge conflict without changing either validated branch", async () => {
        const f = fixture();
        put(f.repository, "upstream.txt", "fork changed line\n");
        commit(f.repository, "Customize the same upstream line");
        git(f.repository, "push", "origin", BRANCH);
        const head = git(f.repository, "rev-parse", "HEAD");
        f.publishUpstream(true);
        f.options.build = async () => assert.fail("A conflict must not be built");
        await assert.rejects(runUpdate(f.options), /diagnostic conservés/);
        assertUnchanged(f, head);
        assert.equal(git(f.repository, "worktree", "list", "--porcelain").match(/^worktree /gm)?.length, 2);
    });

    void it("should retain failure diagnostics and keep both validated refs unchanged when a build fails", async () => {
        const f = fixture();
        f.publishUpstream();
        f.options.build = async () => {
            throw new Error("simulated build failure");
        };
        await assert.rejects(runUpdate(f.options), /simulated build failure/);
        assertUnchanged(f);
        const state = path.join(f.repository, ".git/menubar-updates");
        const runs = fs.readdirSync(state);
        assert.equal(runs.length, 1);
        assert.match(fs.readFileSync(path.join(state, runs[0], "build.log"), "utf8"), /simulated build failure/);
        assert.ok(JSON.parse(fs.readFileSync(path.join(state, runs[0], "preparation.json"), "utf8")).candidate);
    });

    void it("should refuse dirty sources, an unexpected remote and an occupied update lock", async () => {
        const f = fixture();
        put(f.repository, "untracked.txt", "unfinished work");
        await assert.rejects(runUpdate(f.options), /modifications non enregistrées/);
        fs.unlinkSync(path.join(f.repository, "untracked.txt"));
        await assert.rejects(
            runUpdate({ ...f.options, expectedOrigin: "https://example.invalid/wrong.git" }),
            /remote origin/,
        );
        const lock = path.join(f.repository, ".git/menubar-updates/lock");
        fs.mkdirSync(lock);
        await assert.rejects(runUpdate(f.options), /déjà en cours/);
        assert.ok(fs.existsSync(lock));
        assertUnchanged(f);
    });

    void it("should refuse a downgrade or prerelease returned by discovery", async () => {
        const f = fixture();
        await assert.rejects(runUpdate({ ...f.options, latestRelease: async () => "v0.9.0" }), /plus ancienne/);
        await assert.rejects(runUpdate({ ...f.options, latestRelease: async () => "v1.1.0-rc.1" }), /stable reconnue/);
        assertUnchanged(f);
    });

    void it("should not publish when another local commit appears while the build runs", async () => {
        const f = fixture();
        f.publishUpstream();
        const originalBuild = f.options.build!;
        f.options.build = async (...args): Promise<void> => {
            await originalBuild(...args);
            put(f.repository, "another-change.txt", "new local change");
            commit(f.repository, "Another local edit");
        };
        await assert.rejects(runUpdate(f.options), /branche a changé/);
        assert.notEqual(git(f.repository, "rev-parse", "HEAD"), f.head);
        assert.equal(git(f.remote, "rev-parse", BRANCH), f.head);
    });

    void it("should not overwrite a remote commit published during the build", async () => {
        const f = fixture();
        f.publishUpstream();
        const originalBuild = f.options.build!;
        let remoteHead = "";
        f.options.build = async (...args): Promise<void> => {
            await originalBuild(...args);
            const other = path.join(path.dirname(f.repository), "other-publisher");
            git(f.repository, "clone", "--branch", BRANCH, f.remote, other);
            configureGit(other);
            put(other, "remote-change.txt", "another published change");
            commit(other, "Publish an independent change");
            git(other, "push", "origin", BRANCH);
            remoteHead = git(other, "rev-parse", "HEAD");
        };
        await assert.rejects(runUpdate(f.options), /GitHub et la branche locale diffèrent/);
        assert.equal(git(f.repository, "rev-parse", "HEAD"), f.head);
        assert.equal(git(f.remote, "rev-parse", BRANCH), remoteHead);
    });

    void it("should keep the local branch unchanged when publication is rejected", async () => {
        const f = fixture();
        f.publishUpstream();
        put(f.remote, "hooks/pre-receive", "#!/bin/sh\nexit 1\n");
        fs.chmodSync(path.join(f.remote, "hooks/pre-receive"), 0o755);
        await assert.rejects(runUpdate(f.options), /pre-receive hook declined/);
        assertUnchanged(f);
    });

    void it("should not publish when the build changes the candidate commit", async () => {
        const f = fixture();
        f.publishUpstream();
        const originalBuild = f.options.build!;
        f.options.build = async (candidate, log): Promise<void> => {
            await originalBuild(candidate, log);
            put(candidate, "unexpected.txt", "unexpected commit");
            commit(candidate, "Unexpected build-time source change");
        };
        await assert.rejects(runUpdate(f.options), /construction a changé le commit/);
        assertUnchanged(f);
    });
});
