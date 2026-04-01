"use client";

export type ResolvedPlaybackSource = {
	url: string;
	type: "mp4" | "raw";
	supportsCrossOrigin: boolean;
};

type ProbeResult = {
	url: string;
	response: Response;
};

type ResolvePlaybackSourceInput = {
	videoSrc: string;
	rawFallbackSrc?: string;
	enableCrossOrigin?: boolean;
	fetchImpl?: typeof fetch;
	now?: () => number;
	createVideoElement?: () => Pick<HTMLVideoElement, "canPlayType">;
	preferredSource?: "mp4" | "raw";
};

function appendCacheBust(url: string, timestamp: number): string {
	return url.includes("?")
		? `${url}&_t=${timestamp}`
		: `${url}?_t=${timestamp}`;
}

function isPlayableProbeResponse(response: Response): boolean {
	return response.ok || response.status === 206;
}

function isWebMContentType(contentType: string, url: string): boolean {
	return (
		contentType.toLowerCase().includes("video/webm") ||
		/\.webm(?:$|[?#])/i.test(url)
	);
}

async function probePlaybackSource(
	url: string,
	fetchImpl: typeof fetch,
	now: () => number,
): Promise<ProbeResult | null> {
	const requestUrl = appendCacheBust(url, now());

	try {
		const response = await fetchImpl(requestUrl, {
			headers: { range: "bytes=0-0" },
		});

		if (!isPlayableProbeResponse(response)) {
			return null;
		}

		return {
			url: response.redirected ? response.url : requestUrl,
			response,
		};
	} catch {
		return null;
	}
}

export function detectCrossOriginSupport(url: string): boolean {
	try {
		const hostname = new URL(url, "https://cap.so").hostname;
		const isR2OrS3 =
			hostname.includes("r2.cloudflarestorage.com") ||
			hostname.includes("s3.amazonaws.com") ||
			hostname.includes(".s3.");
		return !isR2OrS3;
	} catch {
		return true;
	}
}

export function canPlayRawContentType(
	contentType: string,
	url: string,
	createVideoElement: () => Pick<HTMLVideoElement, "canPlayType"> = () =>
		document.createElement("video"),
): boolean {
	if (!isWebMContentType(contentType, url)) {
		return true;
	}

	const video = createVideoElement();
	return (
		video.canPlayType(contentType) !== "" ||
		video.canPlayType("video/webm") !== ""
	);
}

export function shouldFallbackToRawPlaybackSource(
	resolvedSourceType: ResolvedPlaybackSource["type"] | null | undefined,
	rawFallbackSrc: string | undefined,
	hasTriedRawFallback: boolean,
): boolean {
	return Boolean(
		rawFallbackSrc && resolvedSourceType === "mp4" && !hasTriedRawFallback,
	);
}

export async function resolvePlaybackSource({
	videoSrc,
	rawFallbackSrc,
	enableCrossOrigin = false,
	fetchImpl = fetch,
	now = () => Date.now(),
	createVideoElement,
	preferredSource = "mp4",
}: ResolvePlaybackSourceInput): Promise<ResolvedPlaybackSource | null> {
	const resolveRaw = async (): Promise<ResolvedPlaybackSource | null> => {
		if (!rawFallbackSrc) {
			return null;
		}

		const rawResult = await probePlaybackSource(rawFallbackSrc, fetchImpl, now);

		if (!rawResult) {
			return null;
		}

		const contentType = rawResult.response.headers.get("content-type") ?? "";

		if (
			!canPlayRawContentType(contentType, rawResult.url, createVideoElement)
		) {
			return null;
		}

		return {
			url: rawResult.url,
			type: "raw",
			supportsCrossOrigin:
				enableCrossOrigin && detectCrossOriginSupport(rawResult.url),
		};
	};

	if (preferredSource === "raw") {
		return await resolveRaw();
	}

	const mp4Result = await probePlaybackSource(videoSrc, fetchImpl, now);

	if (mp4Result) {
		return {
			url: mp4Result.url,
			type: "mp4",
			supportsCrossOrigin:
				enableCrossOrigin && detectCrossOriginSupport(mp4Result.url),
		};
	}

	return await resolveRaw();
}
