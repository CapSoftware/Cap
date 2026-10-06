import * as dialog from "@tauri-apps/plugin-dialog";
import type { IncompleteRecordingInfo } from "./tauri";

type DiscardableRecording = Pick<
	IncompleteRecordingInfo,
	"projectPath" | "prettyName" | "totalBytes"
>;

const byteUnits = ["B", "KB", "MB", "GB", "TB"];

export function formatRecordingSize(bytes: number): string {
	let size = bytes;
	let unitIndex = 0;
	while (size >= 1024 && unitIndex < byteUnits.length - 1) {
		size /= 1024;
		unitIndex += 1;
	}
	const value = unitIndex === 0 ? `${size}` : size.toFixed(1);
	return `${value} ${byteUnits[unitIndex]}`;
}

export function discardConfirmationMessage(
	recording: DiscardableRecording,
): string {
	return `"${recording.prettyName}" (${formatRecordingSize(recording.totalBytes)}) will be permanently deleted. This can't be undone.\n\nIts files are at:\n${recording.projectPath}`;
}

export async function confirmAndDiscardRecording(
	recording: DiscardableRecording,
	discard: (projectPath: string) => Promise<unknown>,
): Promise<boolean> {
	const confirmed = await dialog.confirm(
		discardConfirmationMessage(recording),
		{
			title: "Discard incomplete recording",
			kind: "warning",
			okLabel: "Delete permanently",
			cancelLabel: "Cancel",
		},
	);
	if (!confirmed) return false;

	await discard(recording.projectPath);
	return true;
}
