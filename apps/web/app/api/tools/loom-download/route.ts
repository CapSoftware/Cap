import { randomUUID } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";

interface SegmentInfo {
	initUrl: string;
	mediaUrls: string[];
}

function isHlsUrl(url: string): boolean {
	return (url.split("?")[0] ?? "").toLowerCase().endsWith(".m3u8");
}

function isMpdUrl(url: string): boolean {
	return (url.split("?")[0] ?? "").toLowerCase().endsWith(".mpd");
}

function isStreamingUrl(url: string): boolean {
	return isHlsUrl(url) || isMpdUrl(url);
}

function parseMpdSegments(
	mpdXml: string,
	baseUrl: string,
	queryParams: string,
): { video: SegmentInfo | null; audio: SegmentInfo | null } {
	const result = {
		video: null as SegmentInfo | null,
		audio: null as SegmentInfo | null,
	};

	const adaptationSets = [
		...mpdXml.matchAll(/<AdaptationSet([^>]*)>([\s\S]*?)<\/AdaptationSet>/g),
	];

	for (const asMatch of adaptationSets) {
		const attrs = asMatch[1] ?? "";
		const content = asMatch[2] ?? "";
		const contentType = attrs.match(/contentType="([^"]+)"/)?.[1];

		if (contentType !== "video" && contentType !== "audio") continue;

		const representations = [
			...content.matchAll(
				/<Representation([^>]*)>([\s\S]*?)<\/Representation>/g,
			),
		];
		let bestBandwidth = 0;
		let bestRepContent = "";

		for (const repMatch of representations) {
			const repAttrs = repMatch[1] ?? "";
			const repContent = repMatch[2] ?? "";
			const bandwidth = parseInt(
				repAttrs.match(/bandwidth="(\d+)"/)?.[1] ?? "0",
				10,
			);
			if (bandwidth > bestBandwidth) {
				bestBandwidth = bandwidth;
				bestRepContent = repContent;
			}
		}

		if (!bestRepContent) continue;

		const templateMatch = bestRepContent.match(
			/<SegmentTemplate([^>]*)>([\s\S]*?)<\/SegmentTemplate>/,
		);
		if (!templateMatch) continue;

		const templateAttrs = templateMatch[1] ?? "";
		const templateContent = templateMatch[2] ?? "";

		const initFilename = templateAttrs.match(/initialization="([^"]+)"/)?.[1];
		const mediaTemplate = templateAttrs.match(/media="([^"]+)"/)?.[1];
		const startNumber = parseInt(
			templateAttrs.match(/startNumber="(\d+)"/)?.[1] ?? "0",
			10,
		);

		if (!initFilename || !mediaTemplate) continue;

		const sElements = [...templateContent.matchAll(/<S\s([^/]*?)\/>/g)];
		let segmentCount = 0;

		for (const sEl of sElements) {
			const r = parseInt(sEl[1]?.match(/r="(\d+)"/)?.[1] ?? "0", 10);
			segmentCount += 1 + r;
		}

		const initUrl = `${baseUrl}${initFilename}${queryParams}`;
		const mediaUrls: string[] = [];
		for (let i = startNumber; i < startNumber + segmentCount; i++) {
			const filename = mediaTemplate.replace("$Number$", String(i));
			mediaUrls.push(`${baseUrl}${filename}${queryParams}`);
		}

		const info: SegmentInfo = { initUrl, mediaUrls };

		if (contentType === "video") result.video = info;
		else result.audio = info;
	}

	return result;
}

async function streamSegments(
	segments: SegmentInfo,
	controller: ReadableStreamDefaultController<Uint8Array>,
) {
	const initResponse = await fetch(segments.initUrl);
	if (!initResponse.ok || !initResponse.body) {
		throw new Error(`Failed to fetch init segment: ${initResponse.status}`);
	}
	const initReader = initResponse.body.getReader();
	let done = false;
	while (!done) {
		const result = await initReader.read();
		done = result.done;
		if (result.value) controller.enqueue(result.value);
	}

	for (const mediaUrl of segments.mediaUrls) {
		const mediaResponse = await fetch(mediaUrl);
		if (!mediaResponse.ok || !mediaResponse.body) {
			throw new Error(`Failed to fetch media segment: ${mediaResponse.status}`);
		}
		const mediaReader = mediaResponse.body.getReader();
		done = false;
		while (!done) {
			const result = await mediaReader.read();
			done = result.done;
			if (result.value) controller.enqueue(result.value);
		}
	}
}

function parseHlsMasterPlaylist(
	content: string,
	baseUrl: string,
	queryParams: string,
): { bestVariantUrl: string | null; audioRenditionUrl: string | null } {
	const lines = content.split("\n").map((l) => l.trim());
	let audioRenditionUrl: string | null = null;
	let bestBandwidth = 0;
	let bestVariantUrl: string | null = null;

	for (const line of lines) {
		if (line.startsWith("#EXT-X-MEDIA:") && line.includes("TYPE=AUDIO")) {
			const uriMatch = line.match(/URI="([^"]+)"/);
			if (uriMatch?.[1]) {
				const uri = uriMatch[1];
				audioRenditionUrl = uri.startsWith("http")
					? uri
					: `${baseUrl}${uri}${queryParams}`;
			}
		}
	}

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (line?.startsWith("#EXT-X-STREAM-INF:")) {
			const bwMatch = line.match(/BANDWIDTH=(\d+)/);
			const bandwidth = parseInt(bwMatch?.[1] ?? "0", 10);
			const nextLine = lines[i + 1]?.trim();
			if (nextLine && !nextLine.startsWith("#") && bandwidth > bestBandwidth) {
				bestBandwidth = bandwidth;
				bestVariantUrl = nextLine.startsWith("http")
					? nextLine
					: `${baseUrl}${nextLine}${queryParams}`;
			}
		}
	}

	return { bestVariantUrl, audioRenditionUrl };
}

function parseHlsMediaPlaylist(
	content: string,
	baseUrl: string,
	queryParams: string,
): string[] {
	return content
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l && !l.startsWith("#"))
		.map((l) => {
			if (l.startsWith("http")) return l;
			return `${baseUrl}${l}${queryParams}`;
		});
}

async function fetchLoomCdnUrl(
	videoId: string,
	endpoint: string,
	body: Record<string, unknown> | null,
): Promise<string | null> {
	try {
		const options: RequestInit = { method: "POST" };
		if (body) {
			options.headers = {
				"Content-Type": "application/json",
				Accept: "application/json",
			};
			options.body = JSON.stringify(body);
		}

		const response = await fetch(
			`https://www.loom.com/api/campaigns/sessions/${videoId}/${endpoint}`,
			options,
		);

		if (!response.ok || response.status === 204) return null;

		const text = await response.text();
		if (!text.trim()) return null;

		const data = JSON.parse(text) as { url?: string };
		return data.url ?? null;
	} catch {
		return null;
	}
}

async function tryGetDirectMp4Url(videoId: string): Promise<string | null> {
	const requestVariants: Array<{
		endpoint: string;
		body: Record<string, unknown> | null;
	}> = [
		{
			endpoint: "transcoded-url",
			body: {
				anonID: randomUUID(),
				deviceID: null,
				force_original: false,
				password: null,
			},
		},
		{
			endpoint: "raw-url",
			body: {
				anonID: randomUUID(),
				deviceID: null,
				force_original: false,
				password: null,
			},
		},
		{ endpoint: "transcoded-url", body: null },
		{ endpoint: "raw-url", body: null },
	];

	let fallbackStreamingUrl: string | null = null;

	for (const { endpoint, body } of requestVariants) {
		const url = await fetchLoomCdnUrl(videoId, endpoint, body);
		if (!url) continue;

		if (!isStreamingUrl(url)) return url;

		if (!fallbackStreamingUrl) fallbackStreamingUrl = url;
	}

	return fallbackStreamingUrl;
}

async function tryMp4CandidateDownload(
	resourceBaseUrl: string,
	queryParams: string,
	videoId: string,
	filename: string,
): Promise<NextResponse | null> {
	const mp4Candidates = [
		`${resourceBaseUrl}${videoId}.mp4${queryParams}`,
		`${resourceBaseUrl}output.mp4${queryParams}`,
	];

	for (const mp4Url of mp4Candidates) {
		try {
			const headRes = await fetch(mp4Url, { method: "HEAD" });
			if (!headRes.ok) continue;

			const mp4Response = await fetch(mp4Url);
			if (!mp4Response.ok || !mp4Response.body) continue;

			const mp4Body = mp4Response.body;
			const mp4Stream = new ReadableStream<Uint8Array>({
				async start(controller) {
					try {
						const reader = mp4Body.getReader();
						let done = false;
						while (!done) {
							const chunk = await reader.read();
							done = chunk.done;
							if (chunk.value) controller.enqueue(chunk.value);
						}
						controller.close();
					} catch {
						controller.close();
					}
				},
			});

			return new NextResponse(mp4Stream, {
				headers: {
					"Content-Type": "video/mp4",
					"Content-Disposition": `attachment; filename="${filename}"`,
					"Cache-Control": "no-store",
				},
			});
		} catch {}
	}

	return null;
}

export async function GET(request: NextRequest) {
	const videoId = request.nextUrl.searchParams.get("id");
	const videoName = request.nextUrl.searchParams.get("name");

	if (!videoId || videoId.length < 10) {
		return NextResponse.json(
			{ error: "Missing or invalid video ID" },
			{ status: 400 },
		);
	}

	const cdnUrl = await tryGetDirectMp4Url(videoId);

	if (!cdnUrl) {
		return NextResponse.json(
			{
				error:
					"Could not retrieve video URL. The video may be private or the link may have expired.",
			},
			{ status: 404 },
		);
	}

	const sanitizedName = videoName
		? videoName.replace(/[^a-zA-Z0-9\s\-_.]/g, "").trim()
		: "";

	if (!isStreamingUrl(cdnUrl)) {
		const mp4Filename = sanitizedName
			? `${sanitizedName}.mp4`
			: `loom-video-${videoId}.mp4`;

		const directResponse = await fetch(cdnUrl);
		if (directResponse.ok && directResponse.body) {
			const body = directResponse.body;
			const stream = new ReadableStream<Uint8Array>({
				async start(controller) {
					try {
						const reader = body.getReader();
						let done = false;
						while (!done) {
							const chunk = await reader.read();
							done = chunk.done;
							if (chunk.value) controller.enqueue(chunk.value);
						}
						controller.close();
					} catch {
						controller.close();
					}
				},
			});

			return new NextResponse(stream, {
				headers: {
					"Content-Type": "video/mp4",
					"Content-Disposition": `attachment; filename="${mp4Filename}"`,
					"Cache-Control": "no-store",
				},
			});
		}

		return NextResponse.redirect(cdnUrl);
	}

	const parsedUrl = new URL(cdnUrl);
	const queryParams = parsedUrl.search;
	const pathUpToSlash = parsedUrl.pathname.substring(
		0,
		parsedUrl.pathname.lastIndexOf("/") + 1,
	);
	const streamingBaseUrl = `${parsedUrl.origin}${pathUpToSlash}`;

	let resourceBaseUrl = streamingBaseUrl;
	if (pathUpToSlash.endsWith("/hls/")) {
		resourceBaseUrl = `${parsedUrl.origin}${pathUpToSlash.slice(0, -4)}`;
	}

	const mp4Filename = sanitizedName
		? `${sanitizedName}.mp4`
		: `loom-video-${videoId}.mp4`;

	const mp4Result = await tryMp4CandidateDownload(
		resourceBaseUrl,
		queryParams,
		videoId,
		mp4Filename,
	);
	if (mp4Result) return mp4Result;

	if (isMpdUrl(cdnUrl)) {
		const mpdResponse = await fetch(cdnUrl);
		if (!mpdResponse.ok) {
			return NextResponse.json(
				{ error: "Failed to fetch video manifest" },
				{ status: 502 },
			);
		}

		const mpdXml = await mpdResponse.text();
		const { video } = parseMpdSegments(mpdXml, streamingBaseUrl, queryParams);

		if (!video || video.mediaUrls.length === 0) {
			return NextResponse.json(
				{ error: "Could not parse video segments from manifest" },
				{ status: 502 },
			);
		}

		const webmFilename = sanitizedName
			? `${sanitizedName}.webm`
			: `loom-video-${videoId}.webm`;

		const stream = new ReadableStream<Uint8Array>({
			async start(controller) {
				try {
					await streamSegments(video, controller);
					controller.close();
				} catch {
					controller.close();
				}
			},
		});

		return new NextResponse(stream, {
			headers: {
				"Content-Type": "video/webm",
				"Content-Disposition": `attachment; filename="${webmFilename}"`,
				"Cache-Control": "no-store",
			},
		});
	}

	const masterResponse = await fetch(cdnUrl);
	if (!masterResponse.ok) {
		return NextResponse.json(
			{ error: "Failed to fetch HLS playlist" },
			{ status: 502 },
		);
	}

	const masterContent = await masterResponse.text();
	const masterLines = masterContent.split("\n").map((l) => l.trim());

	const isMediaPlaylist = masterLines.some(
		(l) => l.startsWith("#EXTINF:") || l.startsWith("#EXT-X-TARGETDURATION:"),
	);

	let segmentUrls: string[];

	if (isMediaPlaylist) {
		segmentUrls = masterLines
			.filter((l) => l && !l.startsWith("#"))
			.map((l) =>
				l.startsWith("http") ? l : `${streamingBaseUrl}${l}${queryParams}`,
			);
	} else {
		const { bestVariantUrl } = parseHlsMasterPlaylist(
			masterContent,
			streamingBaseUrl,
			queryParams,
		);

		if (!bestVariantUrl) {
			return NextResponse.json(
				{ error: "No video variants found in HLS playlist" },
				{ status: 502 },
			);
		}

		const variantResponse = await fetch(bestVariantUrl);
		if (!variantResponse.ok) {
			return NextResponse.json(
				{ error: "Failed to fetch HLS variant playlist" },
				{ status: 502 },
			);
		}

		const variantContent = await variantResponse.text();
		segmentUrls = parseHlsMediaPlaylist(
			variantContent,
			streamingBaseUrl,
			queryParams,
		);
	}

	if (segmentUrls.length === 0) {
		return NextResponse.json(
			{ error: "No video segments found in HLS playlist" },
			{ status: 502 },
		);
	}

	const tsFilename = sanitizedName
		? `${sanitizedName}.ts`
		: `loom-video-${videoId}.ts`;

	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			try {
				for (const segUrl of segmentUrls) {
					const segResponse = await fetch(segUrl);
					if (!segResponse.ok || !segResponse.body) continue;
					const reader = segResponse.body.getReader();
					let done = false;
					while (!done) {
						const result = await reader.read();
						done = result.done;
						if (result.value) controller.enqueue(result.value);
					}
				}
				controller.close();
			} catch {
				controller.close();
			}
		},
	});

	return new NextResponse(stream, {
		headers: {
			"Content-Type": "video/mp2t",
			"Content-Disposition": `attachment; filename="${tsFilename}"`,
			"Cache-Control": "no-store",
		},
	});
}
