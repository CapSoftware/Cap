import type { CapEventType } from "@cap/app-store";
import type { Video } from "@cap/web-domain";
import { after } from "next/server";

type EventOptions = { commentId?: string };

// Kept free of database and workflow imports: upload, transcription and
// comment paths import this module, and the emitter only loads when an event
// actually fires.
async function emit(
	type: CapEventType,
	videoId: Video.VideoId,
	options: EventOptions,
) {
	try {
		const { emitAppStoreEvent } = await import("./events");
		await emitAppStoreEvent(type, videoId, options);
	} catch (error) {
		console.error("[app-store] Event failed", {
			type,
			videoId,
			message: error instanceof Error ? error.message : String(error),
		});
	}
}

export function announceAppStoreEvent(
	type: CapEventType,
	videoId: Video.VideoId,
	options: EventOptions = {},
): void {
	const work = emit(type, videoId, options);
	try {
		after(work);
	} catch {
		void work;
	}
}

export const emitAppStoreEventSafely = (
	type: CapEventType,
	videoId: Video.VideoId,
	options: EventOptions = {},
) => emit(type, videoId, options);

export const emitCapReadySafely = (videoId: Video.VideoId) =>
	emit("cap.ready", videoId, {});
