import { ALL_FORMATS, Input, UrlSource } from "mediabunny";

export type BrowserEditorMediaMetadata = {
	duration: number;
	width: number | null;
	height: number | null;
	audioChannels: number | null;
	sampleRate: number | null;
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

export async function probeBrowserEditorMedia(
	url: string,
	signal: AbortSignal,
): Promise<BrowserEditorMediaMetadata> {
	if (signal.aborted) {
		throw signal.reason ?? new DOMException("Canceled", "AbortError");
	}
	const input = new Input({
		formats: ALL_FORMATS,
		source: new UrlSource(url, {
			maxCacheSize: 4 * 1024 * 1024,
			fetchFn: boundedMetadataFetch as typeof fetch,
		}),
	});
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
		const duration =
			(await input.getDurationFromMetadata(undefined, {
				skipLiveWait: true,
			})) ?? (await input.computeDuration(undefined, { skipLiveWait: true }));
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
		return { duration, width, height, audioChannels, sampleRate };
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
