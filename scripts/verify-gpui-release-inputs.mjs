import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);

const configNames = {
	darwin: "tauri.macos.conf.json",
	win32: "tauri.windows.conf.json",
	linux: "tauri.linux.conf.json",
};
const configName = configNames[process.platform];

if (!configName) {
	console.log(`Skipping Cap GPUI release validation on ${process.platform}.`);
} else {
	const srcTauri = path.join(repoRoot, "apps/desktop/src-tauri");
	const configPath = path.join(srcTauri, configName);
	const productionConfigPath = path.join(srcTauri, "tauri.prod.conf.json");
	const [config, productionConfig] = await Promise.all([
		fs.readFile(configPath, "utf8").then(JSON.parse),
		fs.readFile(productionConfigPath, "utf8").then(JSON.parse),
	]);
	const externalBin =
		productionConfig.bundle?.externalBin ?? config.bundle?.externalBin;
	if (
		!Array.isArray(externalBin) ||
		!externalBin.includes("binaries/cap-gpui")
	) {
		throw new Error(
			`The effective ${process.platform} release config does not bundle Cap GPUI.`,
		);
	}

	const binariesDir = path.join(srcTauri, "binaries");
	const requestedTarget = process.env.RUST_TARGET_TRIPLE;
	const host = execFileSync("rustc", ["-vV"], { encoding: "utf8" }).match(
		/^host:\s*(.+)$/m,
	)?.[1];
	const target = requestedTarget ?? host;
	if (!target) throw new Error("Could not determine the Rust target triple");

	const extension = process.platform === "win32" ? ".exe" : "";
	const fileName = `cap-gpui-${target}${extension}`;
	const binaryPath = path.join(binariesDir, fileName);
	const releaseBinaryPath = path.join(
		repoRoot,
		"apps",
		"desktop-gpui",
		"target",
		...(requestedTarget ? [target] : []),
		"release",
		`cap-gpui${extension}`,
	);
	const [stagedBinary, releaseBinary] = await Promise.all([
		fs.readFile(binaryPath),
		fs.readFile(releaseBinaryPath),
	]);

	if (stagedBinary.length === 0 || releaseBinary.length === 0) {
		throw new Error("The staged Cap GPUI release binary is empty");
	}

	const sha256 = (contents) =>
		createHash("sha256").update(contents).digest("hex");
	if (sha256(stagedBinary) !== sha256(releaseBinary)) {
		throw new Error(`${binaryPath} does not match ${releaseBinaryPath}`);
	}

	console.log(
		`Verified effective ${process.platform} release configuration and ${fileName} for GPUI packaging.`,
	);
}
