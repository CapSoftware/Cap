import { randomUUID } from "node:crypto";
import { getCurrentUser } from "@cap/database/auth/session";
import { type NextRequest, NextResponse } from "next/server";
import {
	fetchConvertedVideoViaMediaServer,
	isMediaServerConfigured,
} from "@/lib/media-client";
import { convertRemoteVideoToMp4Buffer } from "@/lib/video-convert";

function isHlsUrl(url: string): boolean {
	return (url.split("?")[0] ?? "").toLowerCase().endsWith(".m3u8");
}

function isMpdUrl(url: string): boolean {
	return (url.split("?")[0] ?? "").toLowerCase().endsWith(".mpd");
}

function isStreamingUrl(url: string): boolean {
	return isHlsUrl(url) || isMpdUrl(url);
}

function getInputExtension(url: string): string | undefined {
	const pathname = new URL(url).pathname.toLowerCase();

	if (pathname.endsWith(".m3u8")) {
		return ".m3u8";
	}

	if (pathname.endsWith(".mpd")) {
		return ".mpd";
	}

	if (pathname.endsWith(".mp4")) {
		return ".mp4";
	}

	return undefined;
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
	const user = await getCurrentUser();
	if (!user) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

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

	if (isMediaServerConfigured()) {
		try {
			const convertedResponse = await fetchConvertedVideoViaMediaServer(
				cdnUrl,
				getInputExtension(cdnUrl),
			);

			if (convertedResponse.ok && convertedResponse.body) {
				return new NextResponse(convertedResponse.body, {
					headers: {
						"Content-Type": "video/mp4",
						"Content-Disposition": `attachment; filename="${mp4Filename}"`,
						"Cache-Control": "no-store",
					},
				});
			}

			let errorMessage = "Failed to convert streaming video";
			try {
				const errorData = (await convertedResponse.json()) as {
					error?: string;
					details?: string;
				};
				errorMessage =
					errorData.details ||
					errorData.error ||
					"Failed to convert streaming video";
			} catch {}

			throw new Error(errorMessage);
		} catch (error) {
			if (!errorMessageShouldFallback(error)) {
				return NextResponse.json(
					{
						error:
							error instanceof Error
								? error.message
								: "Failed to convert streaming video",
					},
					{ status: 502 },
				);
			}
		}
	}

	try {
		const mp4Buffer = await convertRemoteVideoToMp4Buffer(cdnUrl);

		return new NextResponse(mp4Buffer, {
			headers: {
				"Content-Type": "video/mp4",
				"Content-Disposition": `attachment; filename="${mp4Filename}"`,
				"Cache-Control": "no-store",
			},
		});
	} catch (error) {
		return NextResponse.json(
			{
				error:
					error instanceof Error
						? error.message
						: "Failed to convert streaming video",
			},
			{ status: 502 },
		);
	}
}

function errorMessageShouldFallback(error: unknown): boolean {
	if (!(error instanceof Error)) {
		return true;
	}

	return error.message === "MEDIA_SERVER_URL is not configured";
}
