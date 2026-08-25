import { RetryableError } from "workflow";

export type MediaServerJobPriority = "normal" | "bulk";

export function isMediaServerCapacityError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /server is busy|server_busy|server is at capacity/i.test(message);
}

export function createMediaServerCapacityError({
	response,
	message,
	videoId,
	priority = "normal",
}: {
	response: Response;
	message: string;
	videoId: string;
	priority?: MediaServerJobPriority;
}): RetryableError {
	const retryAfterSeconds = Number(response.headers.get("Retry-After"));
	const minimumDelayMs =
		Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
			? Math.min(retryAfterSeconds, 300) * 1000
			: 15_000;
	const stableOffset = Array.from(videoId).reduce(
		(total, character) => (total * 31 + character.charCodeAt(0)) % 20_000,
		0,
	);
	const priorityDelayMs = priority === "bulk" ? 15_000 : 0;

	return new RetryableError(message, {
		retryAfter: minimumDelayMs + priorityDelayMs + stableOffset,
	});
}
