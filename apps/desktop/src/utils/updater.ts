import { arch, type as ostype } from "@tauri-apps/plugin-os";
import { relaunch } from "@tauri-apps/plugin-process";
import type { CheckOptions } from "@tauri-apps/plugin-updater";
import { commands } from "~/utils/tauri";

function updaterArch() {
	const currentArch = arch();
	if (currentArch === "x86") return "i686";
	return currentArch;
}

function updaterTarget() {
	const currentArch = updaterArch();
	const os = ostype();

	if (os === "macos") return `darwin-${currentArch}`;
	if (os === "linux") return `linux-${currentArch}-deb`;
	return `${os}-${currentArch}`;
}

export function getUpdaterCheckOptions(): CheckOptions {
	return { target: updaterTarget() };
}

export async function restartAfterUpdate(): Promise<void> {
	await commands.updatesDownloadAndInstall();
	await relaunch();
}

export async function returnToGpui(): Promise<void> {
	await commands.switchToGpuiApp();
}
