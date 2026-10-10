import type { startNativeEditorSession } from "./editor-native";

type NativeEditorSession = Awaited<ReturnType<typeof startNativeEditorSession>>;

const MAX_THUMBNAIL_BYTES = 256 * 1024;

export async function renderEditorClipThumbnail(
	native: NativeEditorSession,
	recordingSegment: unknown,
	time: unknown,
	abortSignal?: AbortSignal,
) {
	if (
		typeof recordingSegment !== "number" ||
		!Number.isInteger(recordingSegment) ||
		recordingSegment < 0 ||
		recordingSegment > 1024 ||
		typeof time !== "number" ||
		!Number.isFinite(time) ||
		time < 0 ||
		time > 43_200
	) {
		throw new Error("Invalid clip thumbnail request");
	}
	const timeMs = Math.round(time * 1000);
	const response = await native.request(
		`/clip-thumbnail/${recordingSegment}/${timeMs}`,
		{
			signal: AbortSignal.any([
				abortSignal ?? new AbortController().signal,
				AbortSignal.timeout(10_000),
			]),
		},
	);
	if (!response.ok) {
		throw new Error(`Editor thumbnail request failed: ${response.status}`);
	}
	if (response.headers.get("content-type") !== "image/jpeg") {
		throw new Error("Editor thumbnail has an invalid format");
	}
	const contentLength = Number(response.headers.get("content-length"));
	if (
		!Number.isSafeInteger(contentLength) ||
		contentLength < 4 ||
		contentLength > MAX_THUMBNAIL_BYTES
	) {
		throw new Error("Editor thumbnail has an invalid size");
	}
	const bytes = Buffer.from(await response.arrayBuffer());
	if (
		bytes.length !== contentLength ||
		bytes[0] !== 0xff ||
		bytes[1] !== 0xd8 ||
		bytes[bytes.length - 2] !== 0xff ||
		bytes[bytes.length - 1] !== 0xd9
	) {
		throw new Error("Editor thumbnail is damaged");
	}
	return `data:image/jpeg;base64,${bytes.toString("base64")}`;
}
