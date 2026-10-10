/**
 * An imported video opens in the editor straight from its upload, instead of
 * after the share video is processed, when every browser can read it the way
 * it reads a processed video: a faststart MP4 or MOV with one H.264 track in
 * a baseline, main or high profile and at most one AAC track.
 * Anything else still waits for processing, which turns it into exactly that.
 */

const MAX_IMPORT_EDITOR_DURATION_SECONDS = 86_400;

const MAX_LONG_SIDE = 4096;
const MAX_SHORT_SIDE = 2304;
const MAX_START_OFFSET_SECONDS = 0.1;
const H264_PROFILES = new Set([66, 77, 100]);
const MAX_TOP_LEVEL_BOXES = 10_000;
const MAX_IMPORT_EDITOR_SOURCE_BYTES = 12 * 1024 * 1024 * 1024;
const FREE_PLAN_DURATION_SECONDS = 300;

export function importEditorSourceKey(ownerId: string, videoId: string) {
	return `${ownerId}/${videoId}/raw-upload.mp4`;
}

export type ImportEditorSource = { duration: number; fps: number };

export type ImportMediaFacts = {
	container: "mp4" | "quicktime" | "other";
	layout: IsobmffLayout;
	duration: number;
	videoTracks: Array<{
		codec: string | null;
		codecString: string | null;
		width: number;
		height: number;
		rotation: number;
		squarePixels: boolean;
		firstTimestamp: number;
		packetRate: number;
		decodable: boolean;
	}>;
	audioTracks: Array<{
		codec: string | null;
		firstTimestamp: number;
		decodable: boolean;
	}>;
};

export function validImportEditorSource(
	value: unknown,
): value is ImportEditorSource {
	if (typeof value !== "object" || value === null) return false;
	const { duration, fps } = value as Record<string, unknown>;
	return (
		typeof duration === "number" &&
		Number.isFinite(duration) &&
		duration > 0 &&
		duration <= MAX_IMPORT_EDITOR_DURATION_SECONDS &&
		Number.isSafeInteger(fps) &&
		Number(fps) >= 1 &&
		Number(fps) <= 120
	);
}

/**
 * The `editorSources` entry that points the editor at an import's upload, or
 * null when it should keep reading the processed video. Processing keeps an
 * upload registered this way instead of deleting it.
 */
export function importEditorSourcesPatch({
	ownerId,
	videoId,
	isPro,
	source,
	upload,
	existingSources,
	head,
}: {
	ownerId: string;
	videoId: string;
	isPro: boolean;
	source: unknown;
	upload: { phase: string | null; rawFileKey: string | null } | null;
	existingSources: unknown;
	head: { size: number | undefined; identity: string | undefined };
}) {
	const key = importEditorSourceKey(ownerId, videoId);
	if (
		!validImportEditorSource(source) ||
		(!isPro && source.duration > FREE_PLAN_DURATION_SECONDS) ||
		upload?.rawFileKey !== key ||
		upload.phase !== "uploading" ||
		(existingSources !== null && existingSources !== undefined) ||
		!Number.isSafeInteger(head.size) ||
		head.size === undefined ||
		head.size < 1 ||
		head.size > MAX_IMPORT_EDITOR_SOURCE_BYTES ||
		!head.identity
	) {
		return null;
	}
	return {
		duration: source.duration,
		editorSources: {
			version: 1 as const,
			display: {
				key,
				contentType: "video/mp4" as const,
				size: head.size,
				fps: source.fps,
				objectIdentity: head.identity,
				embeddedAudio: true as const,
			},
		},
	};
}

function h264Profile(codecString: string | null) {
	const match = /^avc[13]\.([0-9a-f]{2})[0-9a-f]{4}$/i.exec(codecString ?? "");
	return match?.[1] ? Number.parseInt(match[1], 16) : null;
}

export function importEditorSourcePlan(
	facts: ImportMediaFacts,
): ImportEditorSource | null {
	const [video, ...otherVideo] = facts.videoTracks;
	const [audio, ...otherAudio] = facts.audioTracks;
	if (
		facts.container === "other" ||
		facts.layout !== "faststart" ||
		!video ||
		otherVideo.length > 0 ||
		otherAudio.length > 0
	) {
		return null;
	}
	const profile = h264Profile(video.codecString);
	if (
		video.codec !== "avc" ||
		profile === null ||
		!H264_PROFILES.has(profile) ||
		!video.decodable ||
		video.rotation !== 0 ||
		!video.squarePixels ||
		Math.max(video.width, video.height) > MAX_LONG_SIDE ||
		Math.min(video.width, video.height) > MAX_SHORT_SIDE ||
		Math.min(video.width, video.height) < 2 ||
		!(video.firstTimestamp >= 0) ||
		video.firstTimestamp > MAX_START_OFFSET_SECONDS
	) {
		return null;
	}
	if (
		audio &&
		(audio.codec !== "aac" ||
			!audio.decodable ||
			!(Math.abs(audio.firstTimestamp) <= MAX_START_OFFSET_SECONDS))
	) {
		return null;
	}
	const plan = {
		duration: facts.duration,
		fps: Math.round(video.packetRate),
	};
	return validImportEditorSource(plan) ? plan : null;
}

/**
 * Where an MP4 or MOV keeps its index, from its top-level boxes. The editor
 * streams an import's audio once from the start for its waveform, which needs
 * the index first; fragmented files go through a seek index built for
 * recordings, and a media element on one without an index downloads the
 * whole file.
 */
export type IsobmffLayout =
	| "faststart"
	| "index-at-end"
	| "fragmented"
	| "unknown";

export async function isobmffLayout(
	read: (start: number, end: number) => Promise<Uint8Array>,
	size: number,
): Promise<IsobmffLayout> {
	const boxes = async function* (start: number, end: number) {
		let offset = start;
		for (let count = 0; offset + 8 <= end; count++) {
			if (count >= MAX_TOP_LEVEL_BOXES) throw new Error("Too many boxes");
			const header = await read(offset, Math.min(offset + 16, end));
			if (header.byteLength < 8) throw new Error("Truncated box");
			const view = new DataView(
				header.buffer,
				header.byteOffset,
				header.byteLength,
			);
			let boxSize = view.getUint32(0);
			let headerSize = 8;
			if (boxSize === 1) {
				if (header.byteLength < 16) throw new Error("Truncated box");
				boxSize = Number(view.getBigUint64(8));
				headerSize = 16;
			} else if (boxSize === 0) {
				boxSize = end - offset;
			}
			if (boxSize < headerSize || !Number.isSafeInteger(boxSize)) {
				throw new Error("Invalid box");
			}
			yield {
				type: String.fromCharCode(...header.subarray(4, 8)),
				body: offset + headerSize,
				end: Math.min(offset + boxSize, end),
			};
			offset += boxSize;
		}
	};
	let media = false;
	try {
		for await (const box of boxes(0, size)) {
			if (box.type === "moof" || box.type === "mfra" || box.type === "sidx")
				return "fragmented";
			if (box.type === "mdat") media = true;
			if (box.type !== "moov") continue;
			for await (const child of boxes(box.body, box.end)) {
				if (child.type === "mvex") return "fragmented";
			}
			return media ? "index-at-end" : "faststart";
		}
	} catch {
		return "unknown";
	}
	return "unknown";
}
