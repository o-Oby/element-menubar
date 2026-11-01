/*
Copyright 2025 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import path from "node:path";
import { fileURLToPath } from "node:url";
import { type JsonObject } from "shared-types";

import { loadJsonFile } from "./utils.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let buildConfig: BuildConfig;

interface BuildConfig {
    // Immutable package policy: this variant is updated by rebuilding the fork.
    manualUpdates: boolean;
    // Replacement builds can retain existing element:// links without enabling automatic updates.
    registerLegacyProtocol: boolean;
    // Application User Model ID
    appId: string;
    // Protocol string used for OIDC callbacks
    protocol: string;
    // Subject name of the code signing cert used for Windows packages, if signed
    // used as a basis for the Tray GUID which must be rolled if the certificate changes.
    windowsCertSubjectName: string | undefined;
}

export function getBuildConfig(): BuildConfig {
    if (!buildConfig) {
        const packageJson = loadJsonFile(path.join(__dirname, "..", "package.json")) as JsonObject;
        const manualUpdates = packageJson["electron_manual_updates"] === true;
        const registerLegacyProtocol = packageJson["electron_register_legacy_protocol"];
        buildConfig = {
            manualUpdates,
            registerLegacyProtocol:
                typeof registerLegacyProtocol === "boolean" ? registerLegacyProtocol : !manualUpdates,
            appId: (packageJson["electron_appId"] as string) || "im.riot.app",
            protocol: (packageJson["electron_protocol"] as string) || "io.element.desktop",
            windowsCertSubjectName: packageJson["electron_windows_cert_sn"] as string,
        };
    }

    return buildConfig;
}
