import { exec as execCb } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import DSStore from "ds-store";

const exec = promisify(execCb);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const WINDOW_WIDTH = 800;
const WINDOW_HEIGHT = 560;
const APP_X = 280;
const APP_Y = 330;
const APPLICATIONS_X = 520;
const APPLICATIONS_Y = 330;
const OFF_SCREEN = 10000;

async function sleep(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

async function findDmgFiles(targetDir) {
	const possiblePaths = [
		path.join(targetDir, "release", "bundle", "dmg"),
		path.join(targetDir, `${process.env.TAURI_ENV_TARGET_TRIPLE || ""}`, "release", "bundle", "dmg"),
	];

	for (const bundleDir of possiblePaths) {
		try {
			const files = await fs.readdir(bundleDir);
			const dmgFiles = files.filter(f => f.endsWith(".dmg") && !f.endsWith(".original.dmg"));
			if (dmgFiles.length > 0) {
				return { bundleDir, dmgFiles };
			}
		} catch {
			continue;
		}
	}

	throw new Error(`No DMG files found in: ${possiblePaths.join(", ")}`);
}

async function mountDmg(dmgPath) {
	const { stdout } = await exec(`hdiutil attach "${dmgPath}" -readwrite -noverify -noautoopen`);
	const lines = stdout.trim().split("\n");
	const lastLine = lines[lines.length - 1];
	const parts = lastLine.split("\t");
	const mountPoint = parts[parts.length - 1].trim();
	const deviceLine = lines.find(l => l.includes("/dev/disk"));
	const device = deviceLine?.split("\t")[0]?.trim();
	return { mountPoint, device };
}

async function unmountDmg(device) {
	await exec(`hdiutil detach "${device}" -force`);
}

async function getAppName(mountPoint) {
	const files = await fs.readdir(mountPoint);
	const appFile = files.find(f => f.endsWith(".app"));
	return appFile || "Inflight.app";
}

async function fixDsStore(mountPoint, appName) {
	const dsStorePath = path.join(mountPoint, ".DS_Store");

	const store = new DSStore();

	store.setIconSize(128);
	store.setBackgroundColor(1, 1, 1);
	store.setWindowSize(WINDOW_WIDTH, WINDOW_HEIGHT);
	store.setWindowPos(400, 200);
	store.setIconPos(appName, APP_X, APP_Y);
	store.setIconPos("Applications", APPLICATIONS_X, APPLICATIONS_Y);
	store.setIconPos(".background", OFF_SCREEN, OFF_SCREEN);
	store.setIconPos(".VolumeIcon.icns", OFF_SCREEN, OFF_SCREEN);
	store.setIconPos(".DS_Store", OFF_SCREEN, OFF_SCREEN);
	store.setIconPos(".Trashes", OFF_SCREEN, OFF_SCREEN);
	store.setIconPos(".fseventsd", OFF_SCREEN, OFF_SCREEN);

	await new Promise((resolve, reject) => {
		store.write(dsStorePath, (err) => {
			if (err) reject(err);
			else resolve();
		});
	});

	console.log(`Updated .DS_Store at ${dsStorePath}`);
}

async function convertToReadWrite(dmgPath) {
	const rwDmgPath = dmgPath.replace(".dmg", "-rw.dmg");
	await exec(`hdiutil convert "${dmgPath}" -format UDRW -o "${rwDmgPath}"`);
	return rwDmgPath;
}

async function convertToCompressed(rwDmgPath, finalDmgPath) {
	await exec(`hdiutil convert "${rwDmgPath}" -format UDZO -o "${finalDmgPath}"`);
}

async function signDmg(dmgPath) {
	const signingIdentity = process.env.APPLE_SIGNING_IDENTITY;
	if (!signingIdentity) {
		console.log("No APPLE_SIGNING_IDENTITY set, skipping DMG signing");
		return;
	}

	console.log(`Signing DMG with identity: ${signingIdentity}`);
	await exec(`codesign --force --sign "${signingIdentity}" "${dmgPath}"`);
	console.log("DMG signed successfully");
}

async function main() {
	if (process.platform !== "darwin") {
		console.log("Skipping DMG fix - not on macOS");
		return;
	}

	const targetDir = path.join(__dirname, "../../../../target");
	const { bundleDir, dmgFiles } = await findDmgFiles(targetDir);

	for (const dmgFile of dmgFiles) {
		const originalDmgPath = path.join(bundleDir, dmgFile);
		console.log(`\nFixing DMG: ${originalDmgPath}`);

		const rwDmgPath = await convertToReadWrite(originalDmgPath);
		console.log(`Converted to read-write: ${rwDmgPath}`);

		const { mountPoint, device } = await mountDmg(rwDmgPath);
		console.log(`Mounted at: ${mountPoint} (device: ${device})`);

		try {
			const appName = await getAppName(mountPoint);
			console.log(`Found app: ${appName}`);

			await fixDsStore(mountPoint, appName);

			await sleep(1000);
		} finally {
			await unmountDmg(device);
			console.log("Unmounted DMG");
		}

		const backupPath = originalDmgPath.replace(".dmg", ".original.dmg");
		await fs.rename(originalDmgPath, backupPath);

		await convertToCompressed(rwDmgPath, originalDmgPath);
		console.log(`Created final DMG: ${originalDmgPath}`);

		await signDmg(originalDmgPath);

		await fs.unlink(rwDmgPath);
		await fs.unlink(backupPath);

		console.log(`Successfully fixed: ${dmgFile}`);
	}
}

main().catch(err => {
	console.error("Failed to fix DMG:", err);
	process.exit(1);
});
