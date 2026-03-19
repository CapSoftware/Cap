export function formatTime(secs: number, fps?: number) {
	const minutes = Math.floor(secs / 60);
	const seconds = Math.floor(secs % 60);
	const frames = fps === undefined ? undefined : Math.floor((secs % 1) * fps);

	let str = `${minutes}:${seconds.toString().padStart(2, "0")}`;

	if (frames !== undefined) {
		str += `.${frames.toString().padStart(2, "0 ")}`;
	}

	return str;
}

import { getCurrentWindow, ProgressBarStatus } from "@tauri-apps/api/window";
import { createEffect } from "solid-js";

export function createProgressBar(progress: () => number | undefined) {
	const currentWindow = getCurrentWindow();

	createEffect(() => {
		const p = progress();
		if (p === undefined)
			currentWindow.setProgressBar({ status: ProgressBarStatus.None });
		else currentWindow.setProgressBar({ progress: Math.round(p) });
	});
}
