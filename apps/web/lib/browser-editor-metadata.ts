import { ALL_FORMATS, Input, MP4, UrlSource, WEBM } from "mediabunny";
import {
	fragmentedMp4End,
	fragmentedMp4Tracks,
} from "./fragmented-mp4-duration";
import { webmEnd, webmTimecodeScale } from "./webm-audio-duration";

export type BrowserEditorMediaMetadata = {
	duration: number;
	width: number | null;
	height: number | null;
	audioChannels: number | null;
	sampleRate: number | null;
	untaggedSdH264: boolean;
};

function boundedMetadataFetch(input: RequestInfo | URL, init?: RequestInit) {
	const headers = new Headers(init?.headers);
	const range = /^bytes=(\d+)-$/.exec(headers.get("Range") ?? "");
	if (range) {
		const start = Number(range[1]);
		if (Number.isSafeInteger(start)) {
			headers.set("Range", `bytes=${start}-${start + 256 * 1024 - 1}`);
		}
	}
	return fetch(input, { ...init, headers });
}

function metadataInput(url: string) {
	return new Input({
		formats: ALL_FORMATS,
		source: new UrlSource(url, {
			maxCacheSize: 4 * 1024 * 1024,
			fetchFn: boundedMetadataFetch as typeof fetch,
		}),
	});
}

/// Up to `limit` bytes from `start` (open-ended, so the request stays CORS
/// safelisted), and the file size from Content-Range or Content-Length.
async function readRange(
	url: string,
	start: number,
	limit: number,
	signal: AbortSignal,
) {
	const response = await fetch(url, {
		headers: { Range: `bytes=${start}-` },
		signal,
	});
	const range = /\/(\d+)$/.exec(response.headers.get("Content-Range") ?? "");
	const length = Number(response.headers.get("Content-Length"));
	const size = range
		? Number(range[1])
		: Number.isSafeInteger(length)
			? start + length
			: null;
	if (response.status !== 206 || !response.body || size === null) {
		await response.body?.cancel();
		return null;
	}
	const reader = response.body.getReader();
	const bytes = new Uint8Array(Math.min(limit, size - start));
	let filled = 0;
	try {
		while (filled < bytes.length) {
			const { done, value } = await reader.read();
			if (done) break;
			const take = Math.min(value.byteLength, bytes.length - filled);
			bytes.set(value.subarray(0, take), filled);
			filled += take;
		}
	} finally {
		await reader.cancel().catch(() => undefined);
	}
	return { bytes: bytes.subarray(0, filled), size };
}

/// Recordings carry no duration: the recorder writes fragmented MP4 without a
/// fragment index and WebM without Cues, so mediabunny's `computeDuration`
/// walks every fragment, reading most of the file (gigabytes for a long
/// recording). The last fragment or cluster gives the same end time from two
/// small reads.
async function durationFromTail(
	url: string,
	parse: (head: Uint8Array) => ((tail: Uint8Array) => number | null) | null,
	signal: AbortSignal,
) {
	const head = await readRange(url, 0, 256 * 1024, signal);
	const end = head && parse(head.bytes);
	if (!head || !end) return null;
	for (const tailBytes of [2, 8, 32].map((mb) => mb * 1024 * 1024)) {
		const start = Math.max(0, head.size - tailBytes);
		const tail = await readRange(url, start, tailBytes, signal);
		if (!tail || tail.bytes.byteLength !== head.size - start) return null;
		const duration = end(tail.bytes);
		if (duration !== null || start === 0) return duration;
	}
	return null;
}

function mp4TailParser(head: Uint8Array) {
	const tracks = fragmentedMp4Tracks(head);
	return tracks === null
		? null
		: (tail: Uint8Array) => fragmentedMp4End(tail, tracks);
}

function webmTailParser(head: Uint8Array) {
	const scale = webmTimecodeScale(head);
	return scale === null ? null : (tail: Uint8Array) => webmEnd(tail, scale);
}

async function untaggedSdH264(
	video: Awaited<ReturnType<Input["getPrimaryVideoTrack"]>>,
	width: number | null,
	height: number | null,
) {
	if (!video || width === null || height === null) return false;
	if (width > 720 || height > 576) return false;
	const config = await video.getDecoderConfig().catch(() => null);
	return !!config && config.codec.startsWith("avc1") && !config.colorSpace;
}

export async function probeBrowserEditorColor(
	url: string,
	signal: AbortSignal,
) {
	if (signal.aborted) {
		throw signal.reason ?? new DOMException("Canceled", "AbortError");
	}
	const input = metadataInput(url);
	const onAbort = () => input.dispose();
	signal.addEventListener("abort", onAbort, { once: true });
	try {
		const video = await input.getPrimaryVideoTrack();
		if (!video) return false;
		const [width, height] = await Promise.all([
			video.getDisplayWidth(),
			video.getDisplayHeight(),
		]);
		return untaggedSdH264(video, width, height);
	} finally {
		signal.removeEventListener("abort", onAbort);
		input.dispose();
	}
}

export async function probeBrowserEditorMedia(
	url: string,
	signal: AbortSignal,
): Promise<BrowserEditorMediaMetadata> {
	if (signal.aborted) {
		throw signal.reason ?? new DOMException("Canceled", "AbortError");
	}
	const input = metadataInput(url);
	const onAbort = () => input.dispose();
	signal.addEventListener("abort", onAbort, { once: true });
	try {
		const [video, audio] = await Promise.all([
			input.getPrimaryVideoTrack(),
			input.getPrimaryAudioTrack(),
		]);
		if (!video && !audio) {
			throw new Error("Editor media contains no usable tracks");
		}
		const format = await input.getFormat();
		// WebM video blocks carry no durations, so only audio ends are exact.
		const tailParser =
			format === MP4
				? mp4TailParser
				: format === WEBM && !video
					? webmTailParser
					: null;
		// A fragmented MP4's declared duration covers only its first fragment,
		// so the measured end comes first.
		const duration =
			(tailParser &&
				(await durationFromTail(url, tailParser, signal).catch(
					(cause: unknown) => {
						if (signal.aborted) throw cause;
						return null;
					},
				))) ??
			(await input.getDurationFromMetadata(undefined, {
				skipLiveWait: true,
			})) ??
			(await input.computeDuration(undefined, { skipLiveWait: true }));
		const [width, height, audioChannels, sampleRate] = await Promise.all([
			video ? video.getDisplayWidth() : Promise.resolve(null),
			video ? video.getDisplayHeight() : Promise.resolve(null),
			audio ? audio.getNumberOfChannels() : Promise.resolve(null),
			audio ? audio.getSampleRate() : Promise.resolve(null),
		]);
		if (
			!Number.isFinite(duration) ||
			duration <= 0 ||
			duration > 86_400 ||
			(width !== null && (width < 1 || width > 7680)) ||
			(height !== null && (height < 1 || height > 4320)) ||
			(audioChannels !== null && (audioChannels < 1 || audioChannels > 8)) ||
			(sampleRate !== null && (sampleRate < 8000 || sampleRate > 192_000))
		) {
			throw new Error("Editor media metadata is invalid");
		}
		return {
			duration,
			width,
			height,
			audioChannels,
			sampleRate,
			untaggedSdH264: await untaggedSdH264(video, width, height),
		};
	} catch (cause) {
		if (signal.aborted) {
			throw signal.reason ?? new DOMException("Canceled", "AbortError");
		}
		throw cause;
	} finally {
		signal.removeEventListener("abort", onAbort);
		input.dispose();
	}
}
