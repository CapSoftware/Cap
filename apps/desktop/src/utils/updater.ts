import { arch, type as ostype } from "@tauri-apps/plugin-os";
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

	if (os === "macos") return `darwin-${currentArch}-classic`;
	if (os === "linux") return `linux-${currentArch}-appimage-classic`;
	return `${os}-${currentArch}-classic`;
}

export function getUpdaterCheckOptions(): CheckOptions {
	return { target: updaterTarget() };
}

export async function restartAfterUpdate(): Promise<void> {
	await commands.updatesDownloadAndInstall();
	await commands.restartApp();
}
