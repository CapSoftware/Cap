import { randomUUID } from "node:crypto";
import { db } from "@cap/database";
import { videos, videoUploads } from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import { S3Buckets } from "@cap/web-backend";
import { S3Bucket, type Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { Effect, Option } from "effect";
import { FatalError } from "workflow";
import { runPromise } from "@/lib/server";

interface ImportLoomPayload {
	videoId: string;
	userId: string;
	rawFileKey: string;
	bucketId: string | null;
	loomDownloadUrl: string;
	loomVideoId: string;
}

const MINIMUM_VIDEO_SIZE = 1024;

function isStreamingUrl(url: string): boolean {
	const path = (url.split("?")[0] ?? "").toLowerCase();
	return path.endsWith(".m3u8") || path.endsWith(".mpd");
}

function isMpdUrl(url: string): boolean {
	return (url.split("?")[0] ?? "").toLowerCase().endsWith(".mpd");
}

async function fetchLoomCdnUrl(
	videoId: string,
	endpoint: string,
	includeBody: boolean,
): Promise<string | null> {
	try {
		const options: RequestInit = { method: "POST" };
		if (includeBody) {
			options.headers = {
				"Content-Type": "application/json",
				Accept: "application/json",
			};
			options.body = JSON.stringify({
				anonID: randomUUID(),
				deviceID: null,
				force_original: false,
				password: null,
			});
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

async function fetchFreshLoomDownloadUrl(loomVideoId: string): Promise<string> {
	const requestVariants: Array<{ endpoint: string; includeBody: boolean }> = [
		{ endpoint: "transcoded-url", includeBody: true },
		{ endpoint: "raw-url", includeBody: true },
		{ endpoint: "transcoded-url", includeBody: false },
		{ endpoint: "raw-url", includeBody: false },
	];

	let fallbackStreamingUrl: string | null = null;

	for (const { endpoint, includeBody } of requestVariants) {
		const url = await fetchLoomCdnUrl(loomVideoId, endpoint, includeBody);
		if (!url) continue;

		if (!isStreamingUrl(url)) return url;

		if (!fallbackStreamingUrl) fallbackStreamingUrl = url;
	}

	if (fallbackStreamingUrl) return fallbackStreamingUrl;

	throw new FatalError(
		"Could not retrieve a download URL from Loom. The video may be private, password-protected, or the link may have expired.",
	);
}

function parseMpdVideoSegments(
	mpdXml: string,
	baseUrl: string,
	queryParams: string,
): { initUrl: string; mediaUrls: string[] } | null {
	const adaptationSets = [
		...mpdXml.matchAll(/<AdaptationSet([^>]*)>([\s\S]*?)<\/AdaptationSet>/g),
	];

	for (const asMatch of adaptationSets) {
		const attrs = asMatch[1] ?? "";
		const content = asMatch[2] ?? "";
		const contentType = attrs.match(/contentType="([^"]+)"/)?.[1];

		if (contentType !== "video") continue;

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

		return { initUrl, mediaUrls };
	}

	return null;
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
		.map((l) => (l.startsWith("http") ? l : `${baseUrl}${l}${queryParams}`));
}

async function downloadSegmentsToBuffer(urls: string[]): Promise<Buffer> {
	const chunks: Buffer[] = [];
	for (const url of urls) {
		const response = await fetch(url);
		if (!response.ok) continue;
		chunks.push(Buffer.from(await response.arrayBuffer()));
	}
	return Buffer.concat(chunks);
}

async function tryMp4Candidates(
	resourceBaseUrl: string,
	queryParams: string,
	loomVideoId: string,
): Promise<Buffer | null> {
	const mp4Candidates = [
		`${resourceBaseUrl}${loomVideoId}.mp4${queryParams}`,
		`${resourceBaseUrl}output.mp4${queryParams}`,
	];

	for (const mp4Url of mp4Candidates) {
		try {
			const headRes = await fetch(mp4Url, { method: "HEAD" });
			if (!headRes.ok) continue;

			const response = await fetch(mp4Url);
			if (!response.ok) continue;

			const buffer = Buffer.from(await response.arrayBuffer());
			if (buffer.length >= MINIMUM_VIDEO_SIZE) return buffer;
		} catch {}
	}

	return null;
}

async function downloadFromStreamingUrl(
	streamingUrl: string,
	loomVideoId: string,
): Promise<Buffer> {
	const parsedUrl = new URL(streamingUrl);
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

	const mp4Buffer = await tryMp4Candidates(
		resourceBaseUrl,
		queryParams,
		loomVideoId,
	);
	if (mp4Buffer) return mp4Buffer;

	if (isMpdUrl(streamingUrl)) {
		const mpdResponse = await fetch(streamingUrl);
		if (!mpdResponse.ok) {
			throw new FatalError("Failed to fetch video manifest from Loom");
		}

		const mpdXml = await mpdResponse.text();
		const segments = parseMpdVideoSegments(
			mpdXml,
			streamingBaseUrl,
			queryParams,
		);

		if (!segments || segments.mediaUrls.length === 0) {
			throw new FatalError("Could not parse video segments from Loom manifest");
		}

		return await downloadSegmentsToBuffer([
			segments.initUrl,
			...segments.mediaUrls,
		]);
	}

	const masterResponse = await fetch(streamingUrl);
	if (!masterResponse.ok) {
		throw new FatalError("Failed to fetch HLS playlist from Loom");
	}

	const masterContent = await masterResponse.text();
	const masterLines = masterContent.split("\n").map((l) => l.trim());

	const isMediaPlaylist = masterLines.some(
		(l) => l.startsWith("#EXTINF:") || l.startsWith("#EXT-X-TARGETDURATION:"),
	);

	let segmentUrls: string[];

	if (isMediaPlaylist) {
		segmentUrls = parseHlsMediaPlaylist(
			masterContent,
			streamingBaseUrl,
			queryParams,
		);
	} else {
		let bestBandwidth = 0;
		let bestVariantUrl: string | null = null;

		for (let i = 0; i < masterLines.length; i++) {
			const line = masterLines[i];
			if (line?.startsWith("#EXT-X-STREAM-INF:")) {
				const bwMatch = line.match(/BANDWIDTH=(\d+)/);
				const bandwidth = parseInt(bwMatch?.[1] ?? "0", 10);
				const nextLine = masterLines[i + 1]?.trim();
				if (
					nextLine &&
					!nextLine.startsWith("#") &&
					bandwidth > bestBandwidth
				) {
					bestBandwidth = bandwidth;
					bestVariantUrl = nextLine.startsWith("http")
						? nextLine
						: `${streamingBaseUrl}${nextLine}${queryParams}`;
				}
			}
		}

		if (!bestVariantUrl) {
			throw new FatalError("No video variants found in HLS playlist");
		}

		const variantResponse = await fetch(bestVariantUrl);
		if (!variantResponse.ok) {
			throw new FatalError("Failed to fetch HLS variant playlist from Loom");
		}

		const variantContent = await variantResponse.text();
		segmentUrls = parseHlsMediaPlaylist(
			variantContent,
			streamingBaseUrl,
			queryParams,
		);
	}

	if (segmentUrls.length === 0) {
		throw new FatalError("No video segments found in HLS playlist");
	}

	return await downloadSegmentsToBuffer(segmentUrls);
}

async function downloadVideoContent(
	downloadUrl: string,
	loomVideoId: string,
): Promise<Buffer> {
	if (isStreamingUrl(downloadUrl)) {
		return await downloadFromStreamingUrl(downloadUrl, loomVideoId);
	}

	const loomResponse = await fetch(downloadUrl);
	if (!loomResponse.ok) {
		throw new FatalError(
			`Failed to download from Loom: ${loomResponse.status} ${loomResponse.statusText}`,
		);
	}

	const contentType = loomResponse.headers.get("content-type") ?? "";
	if (
		contentType.includes("text/html") ||
		contentType.includes("application/json")
	) {
		throw new FatalError(
			`Loom returned non-video content (${contentType}). The download URL may have expired.`,
		);
	}

	return Buffer.from(await loomResponse.arrayBuffer());
}

interface VideoProcessingResult {
	success: boolean;
	message: string;
	metadata?: {
		duration: number;
		width: number;
		height: number;
		fps: number;
	};
}

export async function importLoomVideoWorkflow(
	payload: ImportLoomPayload,
): Promise<VideoProcessingResult> {
	"use workflow";

	await downloadLoomToS3(payload);

	const result = await processVideoOnMediaServer(payload);

	await saveMetadataAndComplete(payload.videoId, result.metadata);

	return {
		success: true,
		message: "Loom video imported successfully",
		metadata: result.metadata,
	};
}

async function downloadLoomToS3(payload: ImportLoomPayload): Promise<void> {
	"use step";

	const { videoId, loomVideoId, rawFileKey, bucketId } = payload;

	await db()
		.update(videoUploads)
		.set({
			phase: "uploading",
			processingProgress: 0,
			processingMessage: "Downloading from Loom...",
			rawFileKey,
			updatedAt: new Date(),
		})
		.where(eq(videoUploads.videoId, videoId as Video.VideoId));

	const freshDownloadUrl = await fetchFreshLoomDownloadUrl(loomVideoId);

	const bucketIdOption = Option.fromNullable(bucketId).pipe(
		Option.map((id) => S3Bucket.S3BucketId.make(id)),
	);

	const presignedPutUrl = await Effect.gen(function* () {
		const [bucket] = yield* S3Buckets.getBucketAccess(bucketIdOption);
		return yield* bucket.getInternalPresignedPutUrl(rawFileKey, {
			ContentType: "video/mp4",
		});
	}).pipe(runPromise);

	const videoBuffer = await downloadVideoContent(freshDownloadUrl, loomVideoId);

	if (videoBuffer.length < MINIMUM_VIDEO_SIZE) {
		throw new FatalError(
			`Downloaded file is too small (${videoBuffer.length} bytes). The video may not be available for download.`,
		);
	}

	const uploadResponse = await fetch(presignedPutUrl, {
		method: "PUT",
		body: new Uint8Array(videoBuffer),
		headers: {
			"Content-Type": "video/mp4",
			"Content-Length": videoBuffer.length.toString(),
		},
	});

	if (!uploadResponse.ok) {
		throw new FatalError(
			`Failed to upload to S3: ${uploadResponse.status} ${uploadResponse.statusText}`,
		);
	}

	await db()
		.update(videoUploads)
		.set({
			phase: "processing",
			processingProgress: 0,
			processingMessage: "Starting video processing...",
			updatedAt: new Date(),
		})
		.where(eq(videoUploads.videoId, videoId as Video.VideoId));
}

interface MediaServerProcessResult {
	metadata: {
		duration: number;
		width: number;
		height: number;
		fps: number;
	};
}

async function processVideoOnMediaServer(
	payload: ImportLoomPayload,
): Promise<MediaServerProcessResult> {
	"use step";

	const { videoId, userId, rawFileKey, bucketId } = payload;

	const mediaServerUrl = serverEnv().MEDIA_SERVER_URL;
	if (!mediaServerUrl) {
		throw new FatalError("MEDIA_SERVER_URL is not configured");
	}

	const webhookBaseUrl =
		serverEnv().MEDIA_SERVER_WEBHOOK_URL || serverEnv().WEB_URL;

	const bucketIdOption = Option.fromNullable(bucketId).pipe(
		Option.map((id) => S3Bucket.S3BucketId.make(id)),
	);

	const { rawVideoUrl, outputPresignedUrl, thumbnailPresignedUrl } =
		await Effect.gen(function* () {
			const [bucket] = yield* S3Buckets.getBucketAccess(bucketIdOption);

			const outputKey = `${userId}/${videoId}/result.mp4`;
			const thumbnailKey = `${userId}/${videoId}/screenshot/screen-capture.jpg`;

			const rawVideoUrl = yield* bucket.getInternalSignedObjectUrl(rawFileKey);

			const outputPresignedUrl = yield* bucket.getInternalPresignedPutUrl(
				outputKey,
				{ ContentType: "video/mp4" },
			);

			const thumbnailPresignedUrl = yield* bucket.getInternalPresignedPutUrl(
				thumbnailKey,
				{
					ContentType: "image/jpeg",
				},
			);

			return { rawVideoUrl, outputPresignedUrl, thumbnailPresignedUrl };
		}).pipe(runPromise);

	const webhookUrl = `${webhookBaseUrl}/api/webhooks/media-server/progress`;

	const response = await fetch(`${mediaServerUrl}/video/process`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			videoId,
			userId,
			videoUrl: rawVideoUrl,
			outputPresignedUrl,
			thumbnailPresignedUrl,
			webhookUrl,
		}),
	});

	if (!response.ok) {
		const errorData = (await response.json().catch(() => ({}))) as {
			error?: string;
		};
		throw new Error(errorData.error || "Video processing failed to start");
	}

	const { jobId } = (await response.json()) as { jobId: string };

	return await pollForCompletion(mediaServerUrl, jobId);
}

async function pollForCompletion(
	mediaServerUrl: string,
	jobId: string,
): Promise<MediaServerProcessResult> {
	const maxAttempts = 360;
	const pollIntervalMs = 5000;

	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));

		const response = await fetch(
			`${mediaServerUrl}/video/process/${jobId}/status`,
			{
				method: "GET",
				headers: { Accept: "application/json" },
			},
		);

		if (!response.ok) continue;

		const status = (await response.json()) as {
			phase: string;
			progress: number;
			error?: string;
			metadata?: {
				duration: number;
				width: number;
				height: number;
				fps: number;
			};
		};

		if (status.phase === "complete") {
			if (!status.metadata) {
				throw new Error("Processing completed but no metadata returned");
			}
			return { metadata: status.metadata };
		}

		if (status.phase === "error") {
			throw new Error(status.error || "Video processing failed");
		}

		if (status.phase === "cancelled") {
			throw new Error("Video processing was cancelled");
		}
	}

	throw new Error("Video processing timed out");
}

async function saveMetadataAndComplete(
	videoId: string,
	metadata: { duration: number; width: number; height: number; fps: number },
): Promise<void> {
	"use step";

	await db()
		.update(videos)
		.set({
			width: metadata.width,
			height: metadata.height,
			duration: metadata.duration,
		})
		.where(eq(videos.id, videoId as Video.VideoId));

	await db()
		.delete(videoUploads)
		.where(eq(videoUploads.videoId, videoId as Video.VideoId));
}
