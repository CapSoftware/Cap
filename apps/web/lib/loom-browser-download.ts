type LoomUrlResponse = {
	url?: string;
};

type LoomDownloadMode = "direct-download" | "browser-conversion";

export type LoomBrowserDownloadResult = {
	success: boolean;
	videoId?: string;
	videoName?: string;
	downloadUrl?: string;
	downloadMode?: LoomDownloadMode;
	durationSeconds?: number;
	width?: number;
	height?: number;
	error?: string;
};

type LoomOEmbedMetadata = {
	duration?: number;
	width?: number;
	height?: number;
};

const LOOM_API_ROOT = "https://www.loom.com";

export function extractLoomVideoId(url: string): string | null {
	try {
		const parsed = new URL(url);
		if (!parsed.hostname.includes("loom.com")) {
			return null;
		}

		const pathParts = parsed.pathname.split("/").filter(Boolean);
		const id = pathParts[pathParts.length - 1] ?? null;

		if (!id || id.length < 10) {
			return null;
		}

		return id.split("?")[0] ?? null;
	} catch {
		return null;
	}
}

function createAnonId() {
	if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
		return crypto.randomUUID();
	}

	return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function isStreamingUrl(url: string): boolean {
	const path = (url.split("?")[0] ?? "").toLowerCase();
	return path.endsWith(".m3u8") || path.endsWith(".mpd");
}

function isDirectMp4Url(url: string): boolean {
	const path = (url.split("?")[0] ?? "").toLowerCase();
	return path.endsWith(".mp4");
}

async function fetchLoomEndpoint(
	videoId: string,
	endpoint: string,
	includeBody = true,
): Promise<string | null> {
	try {
		const options: RequestInit = {
			method: "POST",
			mode: "cors",
			referrerPolicy: "no-referrer",
		};
		if (includeBody) {
			options.headers = {
				"Content-Type": "application/json",
				Accept: "application/json",
			};
			options.body = JSON.stringify({
				anonID: createAnonId(),
				deviceID: null,
				force_original: false,
				password: null,
			});
		}

		const response = await fetch(
			`${LOOM_API_ROOT}/api/campaigns/sessions/${videoId}/${endpoint}`,
			options,
		);

		if (!response.ok || response.status === 204) {
			return null;
		}

		const text = await response.text();
		if (!text.trim()) {
			return null;
		}

		const data = JSON.parse(text) as LoomUrlResponse;
		return data.url ?? null;
	} catch {
		return null;
	}
}

async function fetchVideoName(videoId: string): Promise<string | null> {
	try {
		const response = await fetch(`${LOOM_API_ROOT}/graphql`, {
			method: "POST",
			mode: "cors",
			referrerPolicy: "no-referrer",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json",
				"x-loom-request-source": "loom_web",
			},
			body: JSON.stringify({
				operationName: "GetVideoName",
				variables: { videoId, password: null },
				query: `query GetVideoName($videoId: ID!, $password: String) {
					getVideo(id: $videoId, password: $password) {
						... on RegularUserVideo { name }
						... on PrivateVideo { id }
						... on VideoPasswordMissingOrIncorrect { id }
					}
				}`,
			}),
		});

		if (!response.ok) return null;

		const data = await response.json();
		return data?.data?.getVideo?.name ?? null;
	} catch {
		return null;
	}
}

async function fetchLoomOEmbed(
	videoId: string,
): Promise<LoomOEmbedMetadata | null> {
	try {
		const response = await fetch(
			`${LOOM_API_ROOT}/v1/oembed?url=https://www.loom.com/share/${videoId}`,
			{
				mode: "cors",
				referrerPolicy: "no-referrer",
				headers: { Accept: "application/json" },
			},
		);
		if (!response.ok) return null;
		const data = await response.json();
		return {
			duration: data.duration ? Math.round(data.duration) : undefined,
			width: data.width ?? undefined,
			height: data.height ?? undefined,
		};
	} catch {
		return null;
	}
}

async function getLoomDownloadUrl(loomVideoId: string): Promise<string | null> {
	const requestVariants: Array<{ endpoint: string; includeBody: boolean }> = [
		{ endpoint: "transcoded-url", includeBody: true },
		{ endpoint: "raw-url", includeBody: true },
		{ endpoint: "transcoded-url", includeBody: false },
		{ endpoint: "raw-url", includeBody: false },
	];

	let fallbackStreamingUrl: string | null = null;

	for (const { endpoint, includeBody } of requestVariants) {
		const url = await fetchLoomEndpoint(loomVideoId, endpoint, includeBody);
		if (!url) continue;

		if (!isStreamingUrl(url)) return url;

		if (!fallbackStreamingUrl) fallbackStreamingUrl = url;
	}

	return fallbackStreamingUrl;
}

export async function resolveLoomBrowserDownload(
	url: string,
): Promise<LoomBrowserDownloadResult> {
	if (!url || typeof url !== "string") {
		return { success: false, error: "Please provide a valid URL." };
	}

	const videoId = extractLoomVideoId(url.trim());
	if (!videoId) {
		return {
			success: false,
			error:
				"Invalid Loom URL. Please paste a valid Loom video link (e.g. https://www.loom.com/share/abc123).",
		};
	}

	try {
		const downloadUrl = await getLoomDownloadUrl(videoId);
		if (!downloadUrl) {
			return {
				success: false,
				error:
					"Could not retrieve a download URL. The video may be private, password-protected, or the link may have expired.",
			};
		}

		const [videoName, oembedMeta] = await Promise.all([
			fetchVideoName(videoId),
			fetchLoomOEmbed(videoId),
		]);

		return {
			success: true,
			videoId,
			videoName: videoName ?? undefined,
			downloadUrl,
			downloadMode: isDirectMp4Url(downloadUrl)
				? "direct-download"
				: "browser-conversion",
			durationSeconds: oembedMeta?.duration,
			width: oembedMeta?.width,
			height: oembedMeta?.height,
		};
	} catch {
		return {
			success: false,
			error:
				"An unexpected error occurred. Please try again or check your internet connection.",
		};
	}
}
