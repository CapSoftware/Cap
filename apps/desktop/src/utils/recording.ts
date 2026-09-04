import { emit } from "@tauri-apps/api/event";
import * as dialog from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import type { createOptionsQuery } from "./queries";
import {
	commands,
	type RecordingAction,
	type RecordingMeta,
	type RecordingMode,
} from "./tauri";

export function isRecordingStartCancelled(error: unknown): boolean {
	const message = error instanceof Error ? error.message : error;
	return message === "Recording cancelled before starting.";
}

export function isRecordingStorageError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : error;
	return (
		typeof message === "string" &&
		message.startsWith("Not enough space to finish this recording.")
	);
}

export function recordingMetaNeedsRecovery(meta: RecordingMeta): boolean {
	const status =
		"status" in meta
			? meta.status
			: "inner" in meta
				? meta.inner.status
				: undefined;
	if (!status || typeof status !== "object" || !("status" in status))
		return false;
	return status.status === "InProgress" || status.status === "NeedsRemux";
}

export function recordingOpenErrorMessage(
	error: unknown,
	projectPath: string,
): string {
	if (isRecordingStorageError(error)) {
		return `Not enough space to finish this recording. Your recording files have been kept at ${projectPath}. Free up space, then open the recording again.`;
	}
	return error instanceof Error ? error.message : String(error);
}

export function handleRecordingResult(
	result: Promise<RecordingAction>,
	setOptions: ReturnType<typeof createOptionsQuery>["setOptions"] | undefined,
) {
	return result
		.then(async (result) => {
			if (result === "Started") return;
			if (result === "InvalidAuthentication") {
				const buttons = setOptions
					? {
							yes: "Login",
							no: "Switch to Studio mode",
							cancel: "Cancel",
						}
					: {
							ok: "Login",
							cancel: "Cancel",
						};

				const result = await dialog.message(
					"You must be authenticated to start an instant mode recording. Login or switch to Studio mode.",
					{
						title: "Authentication required",
						buttons,
					},
				);

				if (result === buttons.yes || result === buttons.ok)
					emit("start-sign-in");
				else if (result === buttons.no && setOptions) {
					setOptions({ mode: "studio" });
					commands.setRecordingMode("studio");
				}
			} else if (result === "UpgradeRequired") commands.showWindow("Upgrade");
			else
				await dialog.message(`Error: ${result}`, {
					title: "Error starting recording",
				});
		})
		.catch((error: unknown) => {
			if (isRecordingStartCancelled(error)) return;
			return dialog.message(
				error instanceof Error ? error.message : String(error),
				{
					title: "Error starting recording",
					kind: "error",
				},
			);
		});
}

export async function openRecordingFolder(
	projectPath: string,
	mode: RecordingMode,
) {
	const path = projectPath.replace(/[/\\]+$/, "");

	const openedContent =
		mode === "instant" &&
		(await commands.openFilePath(`${path}/content`).then(
			() => true,
			() => false,
		));

	if (openedContent) return;

	await revealItemInDir(`${path}/`);
}
