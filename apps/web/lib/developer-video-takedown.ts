import { DEVELOPER_VIDEO_TAKEDOWN_KEY } from "@cap/database/types";

export const DEVELOPER_VIDEO_UNAVAILABLE = "This video is not available.";

export const DEVELOPER_VIDEO_REPORT_EMAIL = "hello@cap.so";

type Marker = { at: string; metadata: unknown };

function asRecord(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function markerOf(metadata: unknown): Marker | null {
	const marker = asRecord(asRecord(metadata)?.[DEVELOPER_VIDEO_TAKEDOWN_KEY]);
	if (!marker || typeof marker.at !== "string" || !("metadata" in marker)) {
		return null;
	}
	return { at: marker.at, metadata: marker.metadata };
}

export function developerVideoTakenDownAt(metadata: unknown): string | null {
	return markerOf(metadata)?.at ?? null;
}

export function developerVideoIsTakenDown(video: {
	metadata: unknown;
}): boolean {
	return markerOf(video.metadata) !== null;
}

export function developerVideoPublicMetadata(metadata: unknown): unknown {
	const marker = markerOf(metadata);
	return marker ? marker.metadata : metadata;
}

export function withoutReservedMetadata<T extends Record<string, unknown>>(
	metadata: T | undefined,
): T | undefined {
	if (!metadata || !(DEVELOPER_VIDEO_TAKEDOWN_KEY in metadata)) return metadata;
	const { [DEVELOPER_VIDEO_TAKEDOWN_KEY]: _reserved, ...rest } = metadata;
	return rest as T;
}

export function developerVideoReportHref(playbackId: string): string {
	const subject = encodeURIComponent(`Report video ${playbackId}`);
	return `mailto:${DEVELOPER_VIDEO_REPORT_EMAIL}?subject=${subject}`;
}

const REFERENCE_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

// Staff paste whatever the report gave them: a playback id, a video id, the
// hosted or embed page, or a playback file URL.
export function developerVideoReference(input: string): string | null {
	const trimmed = input.trim();
	let candidate = trimmed;
	try {
		const segments = new URL(trimmed).pathname.split("/").filter(Boolean);
		const dev = segments.indexOf("dev");
		const playback = segments.indexOf("playback");
		candidate =
			(dev >= 0 ? segments[dev + 1] : undefined) ??
			(playback >= 0 ? segments[playback + 1] : undefined) ??
			segments[0] ??
			"";
	} catch {}
	return REFERENCE_PATTERN.test(candidate) ? candidate : null;
}
