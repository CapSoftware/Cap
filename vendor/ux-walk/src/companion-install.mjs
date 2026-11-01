import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	COMPANION_EXTENSION,
	COMPANION_HOST,
	durableCompanionJson,
	processAlive,
} from "./companion.mjs";

const read = (file) => {
	try {
		return JSON.parse(fs.readFileSync(file));
	} catch (error) {
		if (error.code === "ENOENT") return null;
		throw error;
	}
};
const quote = (value) => `'${String(value).replace(/'/g, "'\\''")}'`;
export function registerCompanion({
	homeDirectory = os.homedir(),
	configDir = process.env.CAP_UX_WALK_CONFIG_DIR ||
		path.join(homeDirectory, ".config/ux-walk"),
	engineDirectory = fileURLToPath(new URL("..", import.meta.url)),
	nodeBinary = process.execPath,
} = {}) {
	const owner = read(path.join(configDir, "companion-session.json")),
		legacy = read(path.join(configDir, "active.json"));
	if (
		(owner && processAlive(owner.pid) && processAlive(owner.recorderPid)) ||
		(legacy && processAlive(legacy.pid))
	)
		throw new Error(
			"Stop the active recording before setting up the companion.",
		);
	const source = path.join(engineDirectory, "extension"),
		key = read(path.join(source, "key.json")),
		manifest = read(path.join(source, "manifest.json"));
	if (key?.id !== COMPANION_EXTENSION || manifest?.key !== key.key)
		throw new Error(
			"Bundled companion identity does not match the native host.",
		);
	const extensionDirectory = path.join(configDir, "companion-extension"),
		staged = `${extensionDirectory}.${process.pid}.staged`;
	if (
		fs.existsSync(extensionDirectory) &&
		read(path.join(extensionDirectory, "cap-companion-source.json"))
			?.extensionId !== COMPANION_EXTENSION
	)
		throw new Error(
			"The companion destination is unmanaged; its files were preserved.",
		);
	fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
	try {
		fs.cpSync(source, staged, {
			recursive: true,
			errorOnExist: true,
			force: false,
		});
		durableCompanionJson(path.join(staged, "cap-companion-source.json"), {
			extensionId: COMPANION_EXTENSION,
			version: manifest.version,
		});
		if (fs.existsSync(extensionDirectory))
			fs.rmSync(extensionDirectory, { recursive: true });
		fs.renameSync(staged, extensionDirectory);
	} finally {
		fs.rmSync(staged, { recursive: true, force: true });
	}
	const launcher = path.join(configDir, "uxw-meet-host.sh");
	fs.writeFileSync(
		launcher,
		`#!/bin/sh\nexport CAP_UX_WALK_CONFIG_DIR=${quote(configDir)}\nexec ${quote(nodeBinary)} ${quote(path.join(engineDirectory, "bin/uxw-meet-host"))} "$@"\n`,
		{ mode: 0o700 },
	);
	fs.chmodSync(launcher, 0o700);
	const registered = [];
	for (const browser of ["Chrome", "Chrome Beta"]) {
		const browserDirectory = path.join(
			homeDirectory,
			"Library/Application Support/Google",
			browser,
		);
		if (!fs.existsSync(browserDirectory)) continue;
		const file = path.join(
			browserDirectory,
			"NativeMessagingHosts",
			`${COMPANION_HOST}.json`,
		);
		durableCompanionJson(file, {
			name: COMPANION_HOST,
			description: "Cap UX companion: selected walkthrough and Meet evidence",
			path: launcher,
			type: "stdio",
			allowed_origins: [`chrome-extension://${COMPANION_EXTENSION}/`],
		});
		registered.push(browser);
	}
	return {
		extensionDirectory,
		extensionId: COMPANION_EXTENSION,
		registered,
		instructions:
			"In chrome://extensions enable Developer mode and Load unpacked this folder. Reload an existing companion only while no recording is active.",
	};
}

if (
	process.argv[1] &&
	path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	try {
		console.log(JSON.stringify(registerCompanion()));
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
	}
}
