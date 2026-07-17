import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type BunFile, file, spawn } from "bun";
import type { VideoMetadata } from "./job-manager";
import {
	DOWNLOAD_TIMEOUT_MS,
	PROCESS_TIMEOUT_MS,
	type ProgressCallback,
	UPLOAD_TIMEOUT_MS,
	withTimeout,
} from "./media-common";
import { probeVideoFile } from "./media-probe";
import { registerSubprocess, terminateProcess } from "./subprocess";
import {
	createTempFile,
	ensureTempDir,
	getTempDir,
	type TempFileHandle,
} from "./temp-files";

const PROCESS_TIMEOUT_PER_SECOND_MS = 20_000;
const MAX_PROCESS_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const THUMBNAIL_TIMEOUT_MS = 60_000;
const PREVIEW_GIF_TIMEOUT_MS = 30_000;
const PROBE_H264_LEVEL_TIMEOUT_MS = 10_000;
const FFMPEG_HLS_CAPABILITY_TIMEOUT_MS = 10_000;
const UPLOAD_MAX_RETRIES = 4;
const UPLOAD_RETRY_BASE_MS = 250;
const MAX_STDERR_BYTES = 64 * 1024;
const REPAIR_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_LEVEL_4_2_WIDTH = 2048;
const MAX_LEVEL_4_2_HEIGHT = 1088;
const MAX_LEVEL_5_1_WIDTH = 4096;
const MAX_LEVEL_5_1_HEIGHT = 2304;
const MULTIPART_MIN_PART_SIZE_BYTES = 5 * 1024 * 1024;
const MULTIPART_MAX_PARTS = 10_000;
const STORAGE_ERROR_BODY_LIMIT_BYTES = 2_048;

export type StorageUploadTarget =
	| {
			type: "put";
			url: string;
	  }
	| {
			type: "multipart";
			videoId: string;
			key: string;
			uploadId: string;
			partSize: number;
			signPartUrl: string;
			completeUrl: string;
			abortUrl: string;
			webhookSecret?: string;
	  };

type UploadedPart = {
	partNumber: number;
	etag: string;
	size: number;
};

export interface VideoProcessingOptions {
	maxWidth?: number;
	maxHeight?: number;
	videoBitrate?: string;
	audioBitrate?: string;
	crf?: number;
	preset?: "ultrafast" | "fast" | "medium" | "slow";
	remuxOnly?: boolean;
	timeoutMs?: number;
}

export interface ThumbnailOptions {
	timestamp?: number;
	width?: number;
	height?: number;
	quality?: number;
}

export interface PreviewGifOptions {
	startTime?: number;
	duration?: number;
	fps?: number;
	maxDimension?: number;
	colors?: number;
	maxBytes?: number;
	timeoutMs?: number;
}

export interface ResilientInputFlags {
	errDetectIgnoreErr?: boolean;
	genPts?: boolean;
	discardCorrupt?: boolean;
	maxMuxingQueueSize?: number;
}

interface PreviewGifAttempt {
	startTime: number;
	duration: number;
	fps: number;
	maxDimension: number;
	colors: number;
	timeoutMs: number;
}

interface XmlElementBlock {
	attributes: Record<string, string>;
	content: string;
}

interface DashSegment {
	duration: number;
	url: string;
}

interface DashRepresentationPlaylist {
	type: "audio" | "video";
	bandwidth: number;
	codecs: string | null;
	width: number | null;
	height: number | null;
	path: string;
}

export interface FfmpegHlsCapabilities {
	allowedSegmentExtensions: boolean;
	extensionPicky: boolean;
}

const LEGACY_FFMPEG_HLS_CAPABILITIES: FfmpegHlsCapabilities = {
	allowedSegmentExtensions: false,
	extensionPicky: false,
};

let ffmpegHlsCapabilitiesPromise: Promise<FfmpegHlsCapabilities> | undefined;

const DEFAULT_OPTIONS: Required<VideoProcessingOptions> = {
	maxWidth: 1920,
	maxHeight: 1080,
	videoBitrate: "5M",
	audioBitrate: "128k",
	crf: 23,
	preset: "medium",
	remuxOnly: false,
	timeoutMs: PROCESS_TIMEOUT_MS,
};

const DEFAULT_THUMBNAIL_OPTIONS: Required<ThumbnailOptions> = {
	timestamp: 1,
	width: 1280,
	height: 720,
	quality: 85,
};

const DEFAULT_PREVIEW_GIF_OPTIONS: Required<PreviewGifOptions> = {
	startTime: 1,
	duration: 4,
	fps: 8,
	maxDimension: 480,
	colors: 48,
	maxBytes: 1_500_000,
	timeoutMs: PREVIEW_GIF_TIMEOUT_MS,
};

export function normalizeVideoInputExtension(
	inputExtension: string | undefined,
): `.${string}` {
	if (!inputExtension) return ".mp4";
	const normalized = inputExtension.trim().toLowerCase();
	if (!normalized) return ".mp4";
	return normalized.startsWith(".")
		? (normalized as `.${string}`)
		: (`.${normalized}` as `.${string}`);
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

function withQuery(url: string, query: string): string {
	if (!query || url.includes("?")) return url;
	return `${url}${query}`;
}

function resolveResourceUrl(
	resource: string,
	baseUrl: string,
	query: string,
): string {
	const resolved = new URL(resource, baseUrl);
	if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
		throw new Error(
			`Unsupported media resource protocol: ${resolved.protocol}`,
		);
	}

	return withQuery(resolved.toString(), query);
}

function getFetchSignal(timeoutMs: number, abortSignal?: AbortSignal) {
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	return abortSignal
		? AbortSignal.any([abortSignal, timeoutSignal])
		: timeoutSignal;
}

function redactUrl(value: string): string {
	try {
		const url = new URL(value);
		if (url.protocol === "file:") {
			return url.pathname;
		}
		return `${url.origin}${url.pathname}`;
	} catch {
		return value.split("?")[0] ?? value;
	}
}

function redactUrlQueries(value: string): string {
	return value.replace(/https?:\/\/[^\s"'<>]+/g, (url) => redactUrl(url));
}

function escapeXmlAttribute(value: string): string {
	return value.replace(/[&<>"']/g, (char) => {
		switch (char) {
			case "&":
				return "&amp;";
			case "<":
				return "&lt;";
			case ">":
				return "&gt;";
			case '"':
				return "&quot;";
			default:
				return "&apos;";
		}
	});
}

export async function materializeHlsPlaylist(
	playlistUrl: string,
	dirPath: string,
	cache = new Map<string, string>(),
	abortSignal?: AbortSignal,
): Promise<string> {
	const cached = cache.get(playlistUrl);
	if (cached) return cached;

	const response = await fetch(playlistUrl, {
		signal: getFetchSignal(DOWNLOAD_TIMEOUT_MS, abortSignal),
	});

	if (!response.ok) {
		throw new Error(
			`Failed to fetch HLS playlist: ${response.status} ${response.statusText}`,
		);
	}

	const content = await response.text();
	const parsedUrl = new URL(playlistUrl);
	const baseUrl = new URL(".", parsedUrl).toString();
	const query = parsedUrl.search;
	const filePath = join(dirPath, `${randomUUID()}.m3u8`);

	cache.set(playlistUrl, filePath);

	const lines = await Promise.all(
		content.split("\n").map(async (line) => {
			const trimmed = line.trim();

			if (!trimmed) return line;

			if (!trimmed.startsWith("#")) {
				const resolved = resolveResourceUrl(trimmed, baseUrl, query);
				return isHlsUrl(resolved)
					? await materializeHlsPlaylist(resolved, dirPath, cache, abortSignal)
					: resolved;
			}

			if (!line.includes('URI="')) return line;

			const matches = [...line.matchAll(/URI="([^"]+)"/g)];
			let rewritten = line;

			for (const match of matches) {
				const original = match[1];
				if (!original) continue;

				const resolved = resolveResourceUrl(original, baseUrl, query);
				const replacement = isHlsUrl(resolved)
					? await materializeHlsPlaylist(resolved, dirPath, cache, abortSignal)
					: resolved;

				rewritten = rewritten.replace(
					`URI="${original}"`,
					`URI="${replacement}"`,
				);
			}

			return rewritten;
		}),
	);

	await writeFile(filePath, lines.join("\n"));
	return filePath;
}

export async function materializeMpdManifest(
	manifestUrl: string,
	dirPath: string,
	abortSignal?: AbortSignal,
): Promise<string> {
	const response = await fetch(manifestUrl, {
		signal: getFetchSignal(DOWNLOAD_TIMEOUT_MS, abortSignal),
	});

	if (!response.ok) {
		throw new Error(
			`Failed to fetch DASH manifest: ${response.status} ${response.statusText}`,
		);
	}

	const content = await response.text();
	const parsedUrl = new URL(manifestUrl);
	const baseUrl = new URL(".", parsedUrl).toString();
	const query = parsedUrl.search;
	const filePath = join(dirPath, `${randomUUID()}.mpd`);
	const rewrittenElements = content.replace(
		/<(BaseURL|Location)(\b[^>]*)>([\s\S]*?)<\/\1>/gi,
		(_, tag: string, attributes: string, resource: string) => {
			const resolved = resolveResourceUrl(
				decodeXmlAttribute(resource.trim()),
				baseUrl,
				query,
			);
			return `<${tag}${attributes}>${escapeXmlAttribute(resolved)}</${tag}>`;
		},
	);

	const rewritten = rewrittenElements.replace(
		/(initialization|media|sourceURL|xlink:href|href)="([^"]+)"/gi,
		(_, attribute: string, resource: string) => {
			const resolved = resolveResourceUrl(
				decodeXmlAttribute(resource),
				baseUrl,
				query,
			);
			return `${attribute}="${escapeXmlAttribute(resolved)}"`;
		},
	);

	await writeFile(filePath, rewritten);
	return filePath;
}

function decodeXmlAttribute(value: string): string {
	return value
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&");
}

function parseXmlAttributes(source: string): Record<string, string> {
	const attributes: Record<string, string> = {};
	const attributePattern = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
	let match = attributePattern.exec(source);

	while (match) {
		const name = match[1];
		if (name) {
			attributes[name] = decodeXmlAttribute(match[2] ?? match[3] ?? "");
		}
		match = attributePattern.exec(source);
	}

	return attributes;
}

function getXmlElementBlocks(
	source: string,
	tagName: string,
): XmlElementBlock[] {
	const blocks: XmlElementBlock[] = [];
	const pairedPattern = new RegExp(
		`<${tagName}\\b([^>]*)>([\\s\\S]*?)<\\/${tagName}>`,
		"gi",
	);
	const selfClosingPattern = new RegExp(`<${tagName}\\b([^>]*)\\/\\s*>`, "gi");
	let match = pairedPattern.exec(source);

	while (match) {
		blocks.push({
			attributes: parseXmlAttributes(match[1] ?? ""),
			content: match[2] ?? "",
		});
		match = pairedPattern.exec(source);
	}

	match = selfClosingPattern.exec(source);
	while (match) {
		blocks.push({
			attributes: parseXmlAttributes(match[1] ?? ""),
			content: "",
		});
		match = selfClosingPattern.exec(source);
	}

	return blocks;
}

function getFirstXmlElementBlock(
	source: string,
	tagName: string,
): XmlElementBlock | null {
	return getXmlElementBlocks(source, tagName)[0] ?? null;
}

function getTextElementValue(source: string, tagName: string): string | null {
	const pattern = new RegExp(
		`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`,
		"i",
	);
	const match = source.match(pattern);
	const value = match?.[1]?.trim();
	return value ? decodeXmlAttribute(value) : null;
}

function parseNumber(value: string | undefined): number | null {
	if (!value) return null;

	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : null;
}

function parsePositiveNumber(value: string | undefined): number | null {
	const parsed = parseNumber(value);
	return parsed !== null && parsed > 0 ? parsed : null;
}

function parseIsoDurationSeconds(value: string | undefined): number | null {
	if (!value) return null;

	const match = value.match(
		/^P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/,
	);
	if (!match) return null;

	const days = Number.parseFloat(match[3] ?? "0");
	const hours = Number.parseFloat(match[4] ?? "0");
	const minutes = Number.parseFloat(match[5] ?? "0");
	const seconds = Number.parseFloat(match[6] ?? "0");

	return days * 86_400 + hours * 3_600 + minutes * 60 + seconds;
}

function inferDashTrackType(
	representationAttrs: Record<string, string>,
	adaptationAttrs: Record<string, string>,
): "audio" | "video" | null {
	const contentType =
		representationAttrs.contentType ?? adaptationAttrs.contentType ?? "";
	const mimeType =
		representationAttrs.mimeType ?? adaptationAttrs.mimeType ?? "";
	const codecs = representationAttrs.codecs ?? adaptationAttrs.codecs ?? "";
	const combined = `${contentType} ${mimeType} ${codecs}`.toLowerCase();

	if (combined.includes("video") || combined.includes("avc")) return "video";
	if (
		combined.includes("audio") ||
		combined.includes("mp4a") ||
		combined.includes("opus")
	) {
		return "audio";
	}

	return null;
}

function getDashResourceBaseUrl(
	manifestBaseUrl: string,
	adaptationContent: string,
	representationContent: string,
): string {
	const adaptationPrefix =
		adaptationContent.split(/<Representation\b/i)[0] ?? "";
	const adaptationBaseUrl = getTextElementValue(adaptationPrefix, "BaseURL");
	const representationBaseUrl = getTextElementValue(
		representationContent,
		"BaseURL",
	);
	const baseUrl = adaptationBaseUrl
		? resolveResourceUrl(adaptationBaseUrl, manifestBaseUrl, "")
		: manifestBaseUrl;

	return representationBaseUrl
		? resolveResourceUrl(representationBaseUrl, baseUrl, "")
		: baseUrl;
}

function substituteDashTemplate(
	template: string,
	values: {
		bandwidth: number;
		number: number;
		representationId: string;
		time: number;
	},
): string {
	const literalDollar = "\0DOLLAR\0";
	return template
		.replace(/\$\$/g, literalDollar)
		.replace(
			/\$(RepresentationID|Bandwidth|Number|Time)(%0(\d+)d)?\$/g,
			(
				_,
				token: string,
				_format: string | undefined,
				width: string | undefined,
			) => {
				const rawValue =
					token === "RepresentationID"
						? values.representationId
						: token === "Bandwidth"
							? values.bandwidth.toString()
							: token === "Number"
								? values.number.toString()
								: values.time.toString();

				return width ? rawValue.padStart(Number(width), "0") : rawValue;
			},
		)
		.replaceAll(literalDollar, "$");
}

function buildDashSegments(
	templateAttrs: Record<string, string>,
	templateContent: string,
	representationId: string,
	bandwidth: number,
	resourceBaseUrl: string,
	query: string,
	presentationDuration: number | null,
): DashSegment[] {
	const media = templateAttrs.media;
	if (!media) {
		throw new Error("DASH SegmentTemplate is missing a media attribute");
	}

	const timescale = parsePositiveNumber(templateAttrs.timescale) ?? 1;
	const startNumber = parseNumber(templateAttrs.startNumber) ?? 1;
	const timeline = getFirstXmlElementBlock(templateContent, "SegmentTimeline");
	const totalDurationTicks =
		presentationDuration !== null
			? Math.ceil(presentationDuration * timescale)
			: null;
	const segments: DashSegment[] = [];

	if (timeline) {
		const timelineSegments = getXmlElementBlocks(timeline.content, "S");
		let currentTime = 0;

		for (const [index, segment] of timelineSegments.entries()) {
			const duration = parsePositiveNumber(segment.attributes.d);
			if (!duration) {
				throw new Error("DASH SegmentTimeline entry is missing duration");
			}

			const explicitTime = parseNumber(segment.attributes.t);
			if (explicitTime !== null) currentTime = explicitTime;

			const repeat = parseNumber(segment.attributes.r) ?? 0;
			let count = repeat + 1;

			if (repeat < 0) {
				const nextTime = parseNumber(timelineSegments[index + 1]?.attributes.t);
				const endTime = nextTime ?? totalDurationTicks;
				if (endTime === null) {
					throw new Error(
						"DASH SegmentTimeline with open-ended repeat requires a duration",
					);
				}
				count = Math.max(0, Math.ceil((endTime - currentTime) / duration));
			}

			for (let offset = 0; offset < count; offset++) {
				const time = currentTime + duration * offset;
				const number = startNumber + segments.length;
				const resource = substituteDashTemplate(media, {
					bandwidth,
					number,
					representationId,
					time,
				});

				segments.push({
					duration: duration / timescale,
					url: resolveResourceUrl(resource, resourceBaseUrl, query),
				});
			}

			currentTime += duration * count;
		}

		return segments;
	}

	const duration = parsePositiveNumber(templateAttrs.duration);
	if (!duration || totalDurationTicks === null) {
		throw new Error(
			"DASH SegmentTemplate requires duration plus mediaPresentationDuration or SegmentTimeline",
		);
	}

	const segmentCount = Math.max(1, Math.ceil(totalDurationTicks / duration));
	for (let index = 0; index < segmentCount; index++) {
		const remainingDuration = totalDurationTicks - duration * index;
		const segmentDuration = Math.min(duration, remainingDuration);
		const number = startNumber + index;
		const time = duration * index;
		const resource = substituteDashTemplate(media, {
			bandwidth,
			number,
			representationId,
			time,
		});

		segments.push({
			duration: segmentDuration / timescale,
			url: resolveResourceUrl(resource, resourceBaseUrl, query),
		});
	}

	return segments;
}

function quoteHlsAttribute(value: string): string {
	return `"${value.replace(/"/g, "%22").replace(/[\r\n]/g, "")}"`;
}

async function writeDashRepresentationPlaylist(
	dirPath: string,
	initUrl: string,
	segments: DashSegment[],
): Promise<string> {
	if (segments.length === 0) {
		throw new Error("DASH manifest did not resolve any media segments");
	}

	const targetDuration = Math.max(
		1,
		Math.ceil(Math.max(...segments.map((segment) => segment.duration))),
	);
	const playlistPath = join(dirPath, `${randomUUID()}.m3u8`);
	const lines = [
		"#EXTM3U",
		"#EXT-X-VERSION:7",
		"#EXT-X-PLAYLIST-TYPE:VOD",
		`#EXT-X-TARGETDURATION:${targetDuration}`,
		`#EXT-X-MAP:URI=${quoteHlsAttribute(initUrl)}`,
		...segments.flatMap((segment) => [
			`#EXTINF:${segment.duration.toFixed(6)},`,
			segment.url,
		]),
		"#EXT-X-ENDLIST",
	];

	await writeFile(playlistPath, lines.join("\n"));
	return playlistPath;
}

function getMasterPlaylistCodecs(
	video: DashRepresentationPlaylist,
	audio: DashRepresentationPlaylist | null,
): string | null {
	const codecs = [video.codecs, audio?.codecs].filter(
		(codec): codec is string => Boolean(codec),
	);
	return codecs.length > 0 ? [...new Set(codecs)].join(",") : null;
}

function shouldFallbackToGenericMpd(error: unknown): boolean {
	return error instanceof Error && error.message.startsWith("DASH ");
}

export async function materializeMpdAsHlsPlaylist(
	manifestUrl: string,
	dirPath: string,
	abortSignal?: AbortSignal,
): Promise<string> {
	const response = await fetch(manifestUrl, {
		signal: getFetchSignal(DOWNLOAD_TIMEOUT_MS, abortSignal),
	});

	if (!response.ok) {
		throw new Error(
			`Failed to fetch DASH manifest: ${response.status} ${response.statusText}`,
		);
	}

	const content = await response.text();
	const sanitizedContent = content.replace(/<!--[\s\S]*?-->/g, "");
	const parsedUrl = new URL(manifestUrl);
	const manifestBaseUrl = new URL(".", parsedUrl).toString();
	const query = parsedUrl.search;
	const mpdAttrs = parseXmlAttributes(
		sanitizedContent.match(/<MPD\b([^>]*)>/i)?.[1] ?? "",
	);
	const periods = getXmlElementBlocks(sanitizedContent, "Period");
	const periodContent =
		periods.length > 0 ? (periods[0]?.content ?? "") : sanitizedContent;
	const periodAttrs = periods[0]?.attributes ?? {};
	const presentationDuration =
		parseIsoDurationSeconds(periodAttrs.duration) ??
		parseIsoDurationSeconds(mpdAttrs.mediaPresentationDuration);
	const playlists: DashRepresentationPlaylist[] = [];

	for (const adaptation of getXmlElementBlocks(
		periodContent,
		"AdaptationSet",
	)) {
		const representationBlocks = getXmlElementBlocks(
			adaptation.content,
			"Representation",
		);
		const adaptationTemplateContent =
			adaptation.content.split(/<Representation\b/i)[0] ?? adaptation.content;
		const adaptationTemplate = getFirstXmlElementBlock(
			adaptationTemplateContent,
			"SegmentTemplate",
		);

		for (const representation of representationBlocks) {
			const type = inferDashTrackType(
				representation.attributes,
				adaptation.attributes,
			);
			if (!type) continue;

			const representationTemplate = getFirstXmlElementBlock(
				representation.content,
				"SegmentTemplate",
			);
			const template = representationTemplate ?? adaptationTemplate;
			if (!template) continue;

			const templateAttrs = {
				...(adaptationTemplate?.attributes ?? {}),
				...template.attributes,
			};
			const initialization = templateAttrs.initialization;
			if (!initialization) {
				throw new Error(
					"DASH SegmentTemplate is missing an initialization attribute",
				);
			}

			const bandwidth =
				parsePositiveNumber(representation.attributes.bandwidth) ??
				parsePositiveNumber(adaptation.attributes.bandwidth) ??
				1_000_000;
			const representationId = representation.attributes.id ?? randomUUID();
			const resourceBaseUrl = getDashResourceBaseUrl(
				manifestBaseUrl,
				adaptation.content,
				representation.content,
			);
			const initResource = substituteDashTemplate(initialization, {
				bandwidth,
				number: parseNumber(templateAttrs.startNumber) ?? 1,
				representationId,
				time: 0,
			});
			const initUrl = resolveResourceUrl(initResource, resourceBaseUrl, query);
			const segments = buildDashSegments(
				templateAttrs,
				template.content,
				representationId,
				bandwidth,
				resourceBaseUrl,
				query,
				presentationDuration,
			);
			const path = await writeDashRepresentationPlaylist(
				dirPath,
				initUrl,
				segments,
			);

			playlists.push({
				type,
				bandwidth,
				codecs:
					representation.attributes.codecs ??
					adaptation.attributes.codecs ??
					null,
				width:
					parsePositiveNumber(representation.attributes.width) ??
					parsePositiveNumber(adaptation.attributes.width),
				height:
					parsePositiveNumber(representation.attributes.height) ??
					parsePositiveNumber(adaptation.attributes.height),
				path,
			});
		}
	}

	const videoPlaylists = playlists.filter(
		(playlist) => playlist.type === "video",
	);
	const audioPlaylists = playlists.filter(
		(playlist) => playlist.type === "audio",
	);

	if (videoPlaylists.length === 0) {
		throw new Error("DASH manifest did not contain a supported video track");
	}

	const masterPath = join(dirPath, `${randomUUID()}.m3u8`);
	const defaultAudio = audioPlaylists[0] ?? null;
	const lines = ["#EXTM3U", "#EXT-X-VERSION:7"];

	if (defaultAudio) {
		lines.push(
			`#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="dash-audio",NAME="audio",DEFAULT=YES,AUTOSELECT=YES,URI=${quoteHlsAttribute(defaultAudio.path)}`,
		);
	}

	for (const video of videoPlaylists) {
		const attributes = [
			`BANDWIDTH=${Math.round(video.bandwidth + (defaultAudio?.bandwidth ?? 0))}`,
		];
		const codecs = getMasterPlaylistCodecs(video, defaultAudio);

		if (video.width && video.height) {
			attributes.push(`RESOLUTION=${video.width}x${video.height}`);
		}
		if (codecs) {
			attributes.push(`CODECS=${quoteHlsAttribute(codecs)}`);
		}
		if (defaultAudio) {
			attributes.push(`AUDIO=${quoteHlsAttribute("dash-audio")}`);
		}

		lines.push(`#EXT-X-STREAM-INF:${attributes.join(",")}`, video.path);
	}

	await writeFile(masterPath, lines.join("\n"));
	return masterPath;
}

export async function materializeStreamingInput(
	videoUrl: string,
	dirPath: string,
	abortSignal?: AbortSignal,
): Promise<string> {
	let inputPath: string;

	if (isHlsUrl(videoUrl)) {
		inputPath = await materializeHlsPlaylist(
			videoUrl,
			dirPath,
			undefined,
			abortSignal,
		);
	} else if (isMpdUrl(videoUrl)) {
		try {
			inputPath = await materializeMpdAsHlsPlaylist(
				videoUrl,
				dirPath,
				abortSignal,
			);
		} catch (err) {
			if (!shouldFallbackToGenericMpd(err)) throw err;
			inputPath = await materializeMpdManifest(videoUrl, dirPath, abortSignal);
		}
	} else {
		return videoUrl;
	}

	for (const entry of await readdir(dirPath)) {
		if (!entry.endsWith(".m3u8") && !entry.endsWith(".mpd")) continue;
		const content = await file(join(dirPath, entry)).text();
		if (/\b(?:file|data):/i.test(content)) {
			throw new Error("Unsupported manifest resource protocol");
		}
	}

	return inputPath;
}

async function drainStream(
	stream: ReadableStream<Uint8Array> | null,
): Promise<void> {
	if (!stream) return;
	try {
		const reader = stream.getReader();
		while (true) {
			const { done } = await reader.read();
			if (done) break;
		}
		reader.releaseLock();
	} catch {}
}

async function readStreamWithLimit(
	stream: ReadableStream<Uint8Array>,
	maxBytes: number,
): Promise<string> {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let totalBytes = 0;

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (totalBytes < maxBytes) {
				const remainingBytes = maxBytes - totalBytes;
				const chunk =
					value.length > remainingBytes
						? value.slice(0, remainingBytes)
						: value;
				chunks.push(chunk);
				totalBytes += chunk.length;
			}
		}
	} finally {
		reader.releaseLock();
	}

	const decoder = new TextDecoder();
	return chunks
		.map((chunk) => decoder.decode(chunk, { stream: true }))
		.join("");
}

async function storageResponseError(
	prefix: string,
	response: Response,
): Promise<Error> {
	const body = response.body
		? await readStreamWithLimit(response.body, STORAGE_ERROR_BODY_LIMIT_BYTES)
		: "";
	const details = body.trim();
	return new Error(
		`${prefix}: ${response.status} ${response.statusText}${details ? ` ${details}` : ""}`,
	);
}

function parseProgressFromStderr(
	stderrLine: string,
	totalDurationUs: number,
): number | null {
	const match = stderrLine.match(/out_time_us=(\d+)/);
	if (!match) return null;
	const currentUs = Number.parseInt(match[1] ?? "0", 10);
	return Math.min(100, (currentUs / totalDurationUs) * 100);
}

async function runFfmpegCommand(
	args: string[],
	timeoutMs: number,
	abortSignal?: AbortSignal,
): Promise<void> {
	const proc = registerSubprocess(
		spawn({
			cmd: args,
			stdout: "pipe",
			stderr: "pipe",
		}),
	);
	let abortCleanup: (() => void) | undefined;
	if (abortSignal) {
		abortCleanup = () => {
			void terminateProcess(proc);
		};
		abortSignal.addEventListener("abort", abortCleanup, { once: true });
	}

	try {
		await withTimeout(
			(async () => {
				void drainStream(proc.stdout as ReadableStream<Uint8Array>);

				const stderrText = await readStreamWithLimit(
					proc.stderr as ReadableStream<Uint8Array>,
					MAX_STDERR_BYTES,
				);

				const exitCode = await proc.exited;

				if (exitCode !== 0) {
					throw new Error(
						`FFmpeg exited with code ${exitCode}. Last stderr: ${redactUrlQueries(stderrText).slice(-2000)}`,
					);
				}
			})(),
			timeoutMs,
			() => terminateProcess(proc),
		);
	} finally {
		if (abortCleanup) {
			abortSignal?.removeEventListener("abort", abortCleanup);
		}
		await terminateProcess(proc);
	}
}

export function parseFfmpegHlsCapabilities(
	helpText: string,
): FfmpegHlsCapabilities {
	return {
		allowedSegmentExtensions: helpText.includes("-allowed_segment_extensions"),
		extensionPicky: helpText.includes("-extension_picky"),
	};
}

async function detectFfmpegHlsCapabilities(): Promise<FfmpegHlsCapabilities> {
	const proc = registerSubprocess(
		spawn({
			cmd: ["ffmpeg", "-hide_banner", "-h", "demuxer=hls"],
			stdout: "pipe",
			stderr: "pipe",
		}),
	);

	try {
		const [stdoutText, stderrText, exitCode] = await withTimeout(
			Promise.all([
				readStreamWithLimit(
					proc.stdout as ReadableStream<Uint8Array>,
					MAX_STDERR_BYTES,
				),
				readStreamWithLimit(
					proc.stderr as ReadableStream<Uint8Array>,
					MAX_STDERR_BYTES,
				),
				proc.exited,
			]),
			FFMPEG_HLS_CAPABILITY_TIMEOUT_MS,
			() => terminateProcess(proc),
		);

		if (exitCode !== 0) {
			throw new Error(
				`Failed to inspect FFmpeg HLS options: ${stderrText.slice(-1000)}`,
			);
		}

		return parseFfmpegHlsCapabilities(`${stdoutText}\n${stderrText}`);
	} finally {
		await terminateProcess(proc);
	}
}

export async function getFfmpegHlsCapabilities(): Promise<FfmpegHlsCapabilities> {
	const capabilitiesPromise =
		ffmpegHlsCapabilitiesPromise ?? detectFfmpegHlsCapabilities();
	ffmpegHlsCapabilitiesPromise = capabilitiesPromise;

	try {
		return await capabilitiesPromise;
	} catch (error) {
		if (ffmpegHlsCapabilitiesPromise === capabilitiesPromise) {
			ffmpegHlsCapabilitiesPromise = undefined;
		}
		throw error;
	}
}

export function buildStreamingDownloadFfmpegArgs(
	inputPath: string,
	outputPath: string,
	capabilities: FfmpegHlsCapabilities = LEGACY_FFMPEG_HLS_CAPABILITIES,
): string[] {
	return [
		"ffmpeg",
		"-threads",
		"2",
		"-protocol_whitelist",
		"file,http,https,tcp,tls,crypto,data",
		"-allowed_extensions",
		"ALL",
		...(capabilities.allowedSegmentExtensions
			? ["-allowed_segment_extensions", "ALL"]
			: []),
		...(capabilities.extensionPicky ? ["-extension_picky", "0"] : []),
		"-i",
		inputPath,
		"-map",
		"0",
		"-c",
		"copy",
		"-y",
		outputPath,
	];
}

async function downloadStreamingVideoToTemp(
	videoUrl: string,
	abortSignal?: AbortSignal,
): Promise<TempFileHandle> {
	await ensureTempDir();
	const manifestDir = await mkdtemp(join(getTempDir(), "stream-"));
	const tempFile = await createTempFile(".mkv");
	const cleanup = async () => {
		await tempFile.cleanup();
		await rm(manifestDir, { force: true, recursive: true }).catch(() => {});
	};

	try {
		const ffmpegHlsCapabilities = await getFfmpegHlsCapabilities();
		const inputPath = await materializeStreamingInput(
			videoUrl,
			manifestDir,
			abortSignal,
		);

		await runFfmpegCommand(
			buildStreamingDownloadFfmpegArgs(
				inputPath,
				tempFile.path,
				ffmpegHlsCapabilities,
			),
			DOWNLOAD_TIMEOUT_MS,
			abortSignal,
		);

		if (file(tempFile.path).size === 0) {
			throw new Error("Streaming download produced empty file");
		}

		return {
			path: tempFile.path,
			cleanup,
		};
	} catch (err) {
		await cleanup();
		throw err;
	}
}

export async function downloadVideoToTemp(
	videoUrl: string,
	inputExtension?: string,
	abortSignal?: AbortSignal,
): Promise<TempFileHandle> {
	if (isStreamingUrl(videoUrl)) {
		return await downloadStreamingVideoToTemp(videoUrl, abortSignal);
	}

	const tempFile = await createTempFile(
		normalizeVideoInputExtension(inputExtension),
	);

	try {
		const timeoutSignal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
		const combinedSignal = abortSignal
			? AbortSignal.any([abortSignal, timeoutSignal])
			: timeoutSignal;

		const response = await fetch(videoUrl, {
			signal: combinedSignal,
		});

		if (!response.ok) {
			const errorBody = await response.text().catch(() => "");
			throw new Error(
				`Failed to download video: ${response.status} ${response.statusText}; ${redactUrlQueries(errorBody).slice(0, 300)}`,
			);
		}

		if (!response.body) {
			throw new Error("No response body");
		}

		const reader = response.body.getReader();
		const writer = file(tempFile.path).writer();
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				writer.write(value);
			}
			await writer.end();
		} finally {
			reader.releaseLock();
		}

		if (file(tempFile.path).size === 0) {
			throw new Error("Downloaded video is empty");
		}

		return tempFile;
	} catch (err) {
		await tempFile.cleanup();
		throw err;
	}
}

function needsVideoTranscode(
	metadata: VideoMetadata,
	options: VideoProcessingOptions,
	sourceH264Level: number | null,
): boolean {
	const maxWidth = options.maxWidth ?? DEFAULT_OPTIONS.maxWidth;
	const maxHeight = options.maxHeight ?? DEFAULT_OPTIONS.maxHeight;
	return (
		metadata.width > maxWidth ||
		metadata.height > maxHeight ||
		metadata.videoCodec !== "h264" ||
		(sourceH264Level !== null &&
			sourceH264Level > pickMobileSafeH264Level(metadata, options).value)
	);
}

function needsAudioTranscode(metadata: VideoMetadata): boolean {
	return Boolean(metadata.audioCodec && metadata.audioCodec !== "aac");
}

function getProcessTimeoutMs(
	durationSeconds: number,
	baseTimeoutMs: number,
): number {
	if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
		return baseTimeoutMs;
	}

	return Math.min(
		MAX_PROCESS_TIMEOUT_MS,
		Math.max(
			baseTimeoutMs,
			Math.ceil(durationSeconds * PROCESS_TIMEOUT_PER_SECOND_MS),
		),
	);
}

export async function repairContainer(
	inputPath: string,
	abortSignal?: AbortSignal,
): Promise<TempFileHandle> {
	const repairedFile = await createTempFile(".mkv");

	try {
		await runFfmpegCommand(
			[
				"ffmpeg",
				"-threads",
				"2",
				"-err_detect",
				"ignore_err",
				"-fflags",
				"+genpts+igndts",
				"-i",
				inputPath,
				"-c",
				"copy",
				"-y",
				repairedFile.path,
			],
			REPAIR_TIMEOUT_MS,
			abortSignal,
		);

		if (file(repairedFile.path).size === 0) {
			throw new Error("Container repair produced empty file");
		}

		return repairedFile;
	} catch (err) {
		await repairedFile.cleanup();
		throw err;
	}
}

function buildExtraInputFlags(flags: ResilientInputFlags): string[] {
	const args: string[] = [];

	if (flags.errDetectIgnoreErr) {
		args.push("-err_detect", "ignore_err");
	}

	const fflags: string[] = [];
	if (flags.genPts) fflags.push("+genpts");
	if (flags.discardCorrupt) fflags.push("+discardcorrupt");
	if (fflags.length > 0) {
		args.push("-fflags", fflags.join(""));
	}

	return args;
}

function buildExtraOutputFlags(flags: ResilientInputFlags): string[] {
	if (flags.maxMuxingQueueSize) {
		return ["-max_muxing_queue_size", flags.maxMuxingQueueSize.toString()];
	}
	return [];
}

type H264Level = {
	value: number;
	ffmpegValue: string;
};

function getTargetVideoDimensions(
	metadata: VideoMetadata,
	options: VideoProcessingOptions,
) {
	const maxWidth = options.maxWidth ?? DEFAULT_OPTIONS.maxWidth;
	const maxHeight = options.maxHeight ?? DEFAULT_OPTIONS.maxHeight;

	return {
		width: Math.min(metadata.width, maxWidth),
		height: Math.min(metadata.height, maxHeight),
	};
}

export function pickMobileSafeH264Level(
	metadata: VideoMetadata,
	options: VideoProcessingOptions = {},
): H264Level {
	const { width, height } = getTargetVideoDimensions(metadata, options);

	if (width <= MAX_LEVEL_4_2_WIDTH && height <= MAX_LEVEL_4_2_HEIGHT) {
		return { value: 42, ffmpegValue: "4.2" };
	}

	if (width <= MAX_LEVEL_5_1_WIDTH && height <= MAX_LEVEL_5_1_HEIGHT) {
		return { value: 51, ffmpegValue: "5.1" };
	}

	return { value: 52, ffmpegValue: "5.2" };
}

async function probeH264Level(
	inputPath: string,
	abortSignal?: AbortSignal,
): Promise<number | null> {
	const proc = registerSubprocess(
		spawn({
			cmd: [
				"ffprobe",
				"-v",
				"error",
				"-select_streams",
				"v:0",
				"-show_entries",
				"stream=level",
				"-of",
				"default=noprint_wrappers=1:nokey=1",
				inputPath,
			],
			stdout: "pipe",
			stderr: "pipe",
		}),
	);
	let abortCleanup: (() => void) | undefined;
	if (abortSignal) {
		abortCleanup = () => {
			void terminateProcess(proc);
		};
		abortSignal.addEventListener("abort", abortCleanup, { once: true });
	}

	try {
		const stdoutPromise = readStreamWithLimit(
			proc.stdout as ReadableStream<Uint8Array>,
			1024,
		);
		const stderrPromise = readStreamWithLimit(
			proc.stderr as ReadableStream<Uint8Array>,
			2048,
		);

		const [stdout] = await withTimeout(
			Promise.all([stdoutPromise, stderrPromise, proc.exited]),
			PROBE_H264_LEVEL_TIMEOUT_MS,
			() => terminateProcess(proc),
		);
		const exitCode = await proc.exited;
		if (exitCode !== 0) return null;

		const rawLevel = stdout.trim().split(/\s+/)[0] ?? "";
		const level = Number.parseInt(rawLevel, 10);
		return Number.isFinite(level) && level > 0 ? level : null;
	} catch {
		return null;
	} finally {
		if (abortCleanup) {
			abortSignal?.removeEventListener("abort", abortCleanup);
		}
		await terminateProcess(proc);
	}
}

export async function processVideo(
	inputPath: string,
	metadata: VideoMetadata,
	options: VideoProcessingOptions = {},
	onProgress?: ProgressCallback,
	abortSignal?: AbortSignal,
	resilientFlags?: ResilientInputFlags,
): Promise<TempFileHandle> {
	const definedOptions = Object.fromEntries(
		Object.entries(options).filter(([, value]) => value !== undefined),
	) as VideoProcessingOptions;
	const opts = { ...DEFAULT_OPTIONS, ...definedOptions };
	const outputTempFile = await createTempFile(".mp4");

	const remuxOnly = opts.remuxOnly;
	const sourceH264Level =
		!remuxOnly && metadata.videoCodec === "h264"
			? await probeH264Level(inputPath, abortSignal)
			: null;
	const targetH264Level = pickMobileSafeH264Level(metadata, opts);
	const videoTranscode = remuxOnly
		? false
		: needsVideoTranscode(metadata, opts, sourceH264Level);
	const audioTranscode = remuxOnly ? false : needsAudioTranscode(metadata);
	const extraInputArgs = resilientFlags
		? buildExtraInputFlags(resilientFlags)
		: [];
	const extraOutputArgs = resilientFlags
		? buildExtraOutputFlags(resilientFlags)
		: [];
	const processTimeoutMs = getProcessTimeoutMs(
		metadata.duration,
		opts.timeoutMs,
	);
	const ffmpegArgs: string[] = [
		"ffmpeg",
		"-threads",
		"2",
		...extraInputArgs,
		"-i",
		inputPath,
	];

	if (videoTranscode) {
		ffmpegArgs.push(
			"-c:v",
			"libx264",
			"-preset",
			opts.preset,
			"-crf",
			opts.crf.toString(),
			"-vf",
			`scale='min(${opts.maxWidth},iw)':'min(${opts.maxHeight},ih)':force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2`,
			"-pix_fmt",
			"yuv420p",
			"-level:v",
			targetH264Level.ffmpegValue,
		);
	} else {
		ffmpegArgs.push("-c:v", "copy");
	}

	if (metadata.audioCodec) {
		if (audioTranscode) {
			ffmpegArgs.push("-c:a", "aac", "-b:a", opts.audioBitrate);
		} else {
			ffmpegArgs.push("-c:a", "copy");
		}
	} else {
		ffmpegArgs.push("-an");
	}

	ffmpegArgs.push(
		"-movflags",
		"+faststart",
		...extraOutputArgs,
		"-progress",
		"pipe:2",
		"-y",
		outputTempFile.path,
	);

	const proc = registerSubprocess(
		spawn({
			cmd: ffmpegArgs,
			stdout: "pipe",
			stderr: "pipe",
		}),
	);
	const totalDurationUs = metadata.duration * 1_000_000;
	let abortCleanup: (() => void) | undefined;
	if (abortSignal) {
		abortCleanup = () => {
			void terminateProcess(proc);
		};
		abortSignal.addEventListener("abort", abortCleanup, { once: true });
	}

	const stderrLines: string[] = [];
	const maxStderrLines = 50;

	try {
		await withTimeout(
			(async () => {
				void drainStream(proc.stdout as ReadableStream<Uint8Array>);

				const stderrReader = (
					proc.stderr as ReadableStream<Uint8Array>
				).getReader();
				const decoder = new TextDecoder();
				let stderrBuffer = "";

				try {
					while (true) {
						const { done, value } = await stderrReader.read();
						if (done) break;

						stderrBuffer += decoder.decode(value, { stream: true });
						const lines = stderrBuffer.split("\n");
						stderrBuffer = lines.pop() ?? "";

						for (const line of lines) {
							stderrLines.push(line);
							if (stderrLines.length > maxStderrLines) {
								stderrLines.shift();
							}
							const progress = parseProgressFromStderr(line, totalDurationUs);
							if (progress !== null && onProgress) {
								onProgress(progress, `Encoding: ${Math.round(progress)}%`);
							}
						}
					}
				} finally {
					stderrReader.releaseLock();
				}

				const exitCode = await proc.exited;
				if (exitCode !== 0) {
					throw new Error(
						`FFmpeg exited with code ${exitCode}. Last stderr: ${stderrLines.slice(-10).join(" | ")}`,
					);
				}

				const outputSize = await file(outputTempFile.path).size;
				if (outputSize === 0) {
					throw new Error("FFmpeg produced empty output file");
				}
			})(),
			processTimeoutMs,
			() => terminateProcess(proc),
		);

		return outputTempFile;
	} catch (err) {
		await outputTempFile.cleanup();
		throw err;
	} finally {
		if (abortCleanup) {
			abortSignal?.removeEventListener("abort", abortCleanup);
		}
		await terminateProcess(proc);
	}
}

function getThumbnailTimestamp(
	duration: number,
	requestedTimestamp: number,
): number {
	if (!Number.isFinite(duration) || duration <= 0) {
		return Math.max(0, requestedTimestamp);
	}

	const timestamp =
		requestedTimestamp <= 0 ? Math.min(duration / 4, 1) : requestedTimestamp;
	return Math.min(Math.max(0, timestamp), Math.max(0, duration - 0.1));
}

export async function generateThumbnail(
	inputPath: string,
	duration: number,
	options: ThumbnailOptions = {},
): Promise<Uint8Array> {
	const opts = { ...DEFAULT_THUMBNAIL_OPTIONS, ...options };
	const timestamp = getThumbnailTimestamp(duration, opts.timestamp);
	const qualityValue = Math.max(
		2,
		Math.min(31, Math.round(31 - (opts.quality / 100) * 29)),
	);
	const ffmpegArgs = [
		"ffmpeg",
		"-ss",
		timestamp.toString(),
		"-i",
		inputPath,
		"-vframes",
		"1",
		"-vf",
		`scale='min(${opts.width},iw)':'min(${opts.height},ih)':force_original_aspect_ratio=decrease`,
		"-q:v",
		qualityValue.toString(),
		"-f",
		"image2",
		"pipe:1",
	];
	const proc = registerSubprocess(
		spawn({
			cmd: ffmpegArgs,
			stdout: "pipe",
			stderr: "pipe",
		}),
	);

	try {
		return await withTimeout(
			(async () => {
				const stderrPromise = readStreamWithLimit(
					proc.stderr as ReadableStream<Uint8Array>,
					MAX_STDERR_BYTES,
				);

				const chunks: Uint8Array[] = [];
				let totalBytes = 0;
				const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();

				try {
					while (true) {
						const { done, value } = await reader.read();
						if (done) break;
						chunks.push(value);
						totalBytes += value.length;
					}
				} finally {
					reader.releaseLock();
				}

				const [, exitCode] = await Promise.all([stderrPromise, proc.exited]);

				if (exitCode !== 0) {
					throw new Error(`FFmpeg thumbnail exited with code ${exitCode}`);
				}
				if (totalBytes === 0) {
					throw new Error("FFmpeg produced empty thumbnail");
				}

				const output = new Uint8Array(totalBytes);
				let offset = 0;
				for (const chunk of chunks) {
					output.set(chunk, offset);
					offset += chunk.length;
				}

				return output;
			})(),
			THUMBNAIL_TIMEOUT_MS,
			() => terminateProcess(proc),
		);
	} finally {
		await terminateProcess(proc);
	}
}

function getPreviewGifOptions(
	options: PreviewGifOptions,
): Required<PreviewGifOptions> {
	const definedOptions = Object.fromEntries(
		Object.entries(options).filter(([, value]) => value !== undefined),
	) as PreviewGifOptions;
	const opts = { ...DEFAULT_PREVIEW_GIF_OPTIONS, ...definedOptions };

	return {
		startTime: Math.max(0, opts.startTime),
		duration: Math.min(
			DEFAULT_PREVIEW_GIF_OPTIONS.duration,
			Math.max(0.5, opts.duration),
		),
		fps: Math.round(
			Math.min(DEFAULT_PREVIEW_GIF_OPTIONS.fps, Math.max(1, opts.fps)),
		),
		maxDimension: Math.round(
			Math.min(
				DEFAULT_PREVIEW_GIF_OPTIONS.maxDimension,
				Math.max(120, opts.maxDimension),
			),
		),
		colors: Math.round(
			Math.min(DEFAULT_PREVIEW_GIF_OPTIONS.colors, Math.max(2, opts.colors)),
		),
		maxBytes: Math.round(Math.max(1, opts.maxBytes)),
		timeoutMs: Math.round(Math.max(5_000, opts.timeoutMs)),
	};
}

function getPreviewGifStartTime(
	videoDuration: number,
	requestedStartTime: number,
	previewDuration: number,
): number {
	if (!Number.isFinite(videoDuration) || videoDuration <= 0) {
		return Math.max(0, requestedStartTime);
	}

	return Math.min(
		Math.max(0, requestedStartTime),
		Math.max(0, videoDuration - previewDuration),
	);
}

function getPreviewGifDuration(
	videoDuration: number,
	startTime: number,
	requestedDuration: number,
): number {
	if (!Number.isFinite(videoDuration) || videoDuration <= 0) {
		return requestedDuration;
	}

	return Math.max(0.5, Math.min(requestedDuration, videoDuration - startTime));
}

function getPreviewGifAttempts(
	duration: number,
	opts: Required<PreviewGifOptions>,
): PreviewGifAttempt[] {
	const startTime = getPreviewGifStartTime(
		duration,
		opts.startTime,
		opts.duration,
	);
	const previewDuration = getPreviewGifDuration(
		duration,
		startTime,
		opts.duration,
	);

	return [
		{
			startTime,
			duration: previewDuration,
			fps: opts.fps,
			maxDimension: opts.maxDimension,
			colors: opts.colors,
			timeoutMs: opts.timeoutMs,
		},
		{
			startTime,
			duration: Math.min(3, previewDuration),
			fps: Math.min(6, opts.fps),
			maxDimension: Math.min(360, opts.maxDimension),
			colors: Math.min(32, opts.colors),
			timeoutMs: opts.timeoutMs,
		},
		{
			startTime,
			duration: Math.min(2, previewDuration),
			fps: Math.min(5, opts.fps),
			maxDimension: Math.min(320, opts.maxDimension),
			colors: Math.min(24, opts.colors),
			timeoutMs: opts.timeoutMs,
		},
		{
			startTime,
			duration: Math.min(1.5, previewDuration),
			fps: Math.min(4, opts.fps),
			maxDimension: Math.min(240, opts.maxDimension),
			colors: Math.min(16, opts.colors),
			timeoutMs: opts.timeoutMs,
		},
	];
}

function getPreviewGifFilter(attempt: PreviewGifAttempt): string {
	return `fps=${attempt.fps},scale='min(${attempt.maxDimension},iw)':'min(${attempt.maxDimension},ih)':force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2,split[s0][s1];[s0]palettegen=stats_mode=diff:max_colors=${attempt.colors}[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`;
}

async function runPreviewGifAttempt(
	inputPath: string,
	outputPath: string,
	attempt: PreviewGifAttempt,
	abortSignal?: AbortSignal,
): Promise<void> {
	if (abortSignal?.aborted) {
		throw new Error("Preview GIF generation aborted");
	}

	await runFfmpegCommand(
		[
			"ffmpeg",
			"-threads",
			"1",
			"-ss",
			attempt.startTime.toString(),
			"-t",
			attempt.duration.toString(),
			"-i",
			inputPath,
			"-an",
			"-filter_complex",
			getPreviewGifFilter(attempt),
			"-loop",
			"0",
			"-f",
			"gif",
			"-y",
			outputPath,
		],
		attempt.timeoutMs,
		abortSignal,
	);
}

export async function generatePreviewGif(
	inputPath: string,
	duration: number,
	options: PreviewGifOptions = {},
	abortSignal?: AbortSignal,
): Promise<TempFileHandle> {
	const opts = getPreviewGifOptions(options);
	const attempts = getPreviewGifAttempts(duration, opts);
	let lastError: unknown;

	for (const [index, attempt] of attempts.entries()) {
		if (abortSignal?.aborted) {
			throw new Error("Preview GIF generation aborted");
		}

		const outputTempFile = await createTempFile(".gif");

		try {
			await runPreviewGifAttempt(
				inputPath,
				outputTempFile.path,
				attempt,
				abortSignal,
			);

			const outputSize = await file(outputTempFile.path).size;
			if (outputSize === 0) {
				throw new Error("FFmpeg produced empty preview GIF");
			}

			if (outputSize <= opts.maxBytes) {
				return outputTempFile;
			}

			throw new Error(
				`Preview GIF exceeds size budget: ${outputSize} bytes > ${opts.maxBytes} bytes`,
			);
		} catch (err) {
			await outputTempFile.cleanup();
			if (abortSignal?.aborted) {
				throw err instanceof Error
					? err
					: new Error("Preview GIF generation aborted");
			}
			lastError = err;
			if (index === attempts.length - 1) {
				throw err;
			}
		}
	}

	throw lastError instanceof Error
		? lastError
		: new Error("Preview GIF generation failed");
}

function isRetryableUploadStatus(status: number): boolean {
	return (
		status === 408 ||
		status === 425 ||
		status === 429 ||
		status === 500 ||
		status === 502 ||
		status === 503 ||
		status === 504
	);
}

function isGoogleDriveResumableUrl(url: string): boolean {
	return url.includes("googleapis.com/upload/drive/");
}

async function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function uploadWithRetry(
	presignedUrl: string,
	contentType: string,
	contentLength: number,
	bodyFactory: () => Blob | BunFile,
): Promise<void> {
	let lastError: Error | undefined;

	for (let attempt = 0; attempt <= UPLOAD_MAX_RETRIES; attempt++) {
		let response: Response;

		try {
			const headers: Record<string, string> = {
				"Content-Type": contentType,
				"Content-Length": contentLength.toString(),
			};
			if (isGoogleDriveResumableUrl(presignedUrl) && contentLength > 0) {
				headers["Content-Range"] =
					`bytes 0-${contentLength - 1}/${contentLength}`;
			}

			response = await fetch(presignedUrl, {
				method: "PUT",
				headers,
				body: bodyFactory(),
				signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
			});
		} catch (err) {
			const uploadError = err instanceof Error ? err : new Error(String(err));

			if (attempt === UPLOAD_MAX_RETRIES) {
				throw uploadError;
			}

			lastError = uploadError;
			await sleep(UPLOAD_RETRY_BASE_MS * 2 ** attempt);
			continue;
		}

		if (response.ok) {
			return;
		}

		const responseError = await storageResponseError(
			"Storage upload failed",
			response,
		);

		if (
			!isRetryableUploadStatus(response.status) ||
			attempt === UPLOAD_MAX_RETRIES
		) {
			throw responseError;
		}

		lastError = responseError;
		await sleep(UPLOAD_RETRY_BASE_MS * 2 ** attempt);
	}

	throw lastError ?? new Error("Storage upload failed after retries");
}

export async function uploadToS3(
	data: Uint8Array | Blob,
	presignedUrl: string,
	contentType: string,
): Promise<void> {
	const blob =
		data instanceof Blob
			? data
			: new Blob([data.buffer as ArrayBuffer], { type: contentType });

	await uploadWithRetry(presignedUrl, contentType, blob.size, () => blob);
}

export async function uploadFileToS3(
	filePath: string,
	presignedUrl: string,
	contentType: string,
): Promise<void> {
	const fileHandle = file(filePath);

	await uploadWithRetry(presignedUrl, contentType, fileHandle.size, () =>
		file(filePath),
	);
}

async function postMultipartJson<TBody extends Record<string, unknown>>(
	url: string,
	body: TBody,
	webhookSecret: string | undefined,
): Promise<Response> {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	if (webhookSecret) {
		headers["x-media-server-secret"] = webhookSecret;
	}

	return await fetch(url, {
		method: "POST",
		headers,
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
	});
}

async function getMultipartPartUrl(
	target: Extract<StorageUploadTarget, { type: "multipart" }>,
	partNumber: number,
	contentLength: number,
): Promise<string> {
	const response = await postMultipartJson(
		target.signPartUrl,
		{
			videoId: target.videoId,
			key: target.key,
			uploadId: target.uploadId,
			partNumber,
			contentLength,
		},
		target.webhookSecret,
	);

	if (!response.ok) {
		throw await storageResponseError("Multipart part signing failed", response);
	}

	const data = await response.json().catch(() => null);
	const url = (data as { url?: unknown } | null)?.url;
	if (typeof url !== "string" || !url) {
		throw new Error("Multipart part signing returned an invalid URL");
	}

	return url;
}

async function uploadMultipartPart(
	url: string,
	body: Blob,
	contentLength: number,
	partNumber: number,
): Promise<string> {
	let lastError: Error | undefined;

	for (let attempt = 0; attempt <= UPLOAD_MAX_RETRIES; attempt++) {
		let response: Response;
		try {
			response = await fetch(url, {
				method: "PUT",
				headers: {
					"Content-Length": contentLength.toString(),
				},
				body,
				signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
			});
		} catch (err) {
			const uploadError = err instanceof Error ? err : new Error(String(err));

			if (attempt === UPLOAD_MAX_RETRIES) {
				throw uploadError;
			}

			lastError = uploadError;
			await sleep(UPLOAD_RETRY_BASE_MS * 2 ** attempt);
			continue;
		}

		if (response.ok) {
			const etag = response.headers.get("etag");
			if (!etag) {
				throw new Error(`Multipart upload part ${partNumber} missing ETag`);
			}
			return etag;
		}

		const responseError = await storageResponseError(
			`Multipart upload part ${partNumber} failed`,
			response,
		);

		if (
			!isRetryableUploadStatus(response.status) ||
			attempt === UPLOAD_MAX_RETRIES
		) {
			throw responseError;
		}

		lastError = responseError;
		await sleep(UPLOAD_RETRY_BASE_MS * 2 ** attempt);
	}

	throw lastError ?? new Error(`Multipart upload part ${partNumber} failed`);
}

async function completeMultipartUpload(
	target: Extract<StorageUploadTarget, { type: "multipart" }>,
	parts: UploadedPart[],
): Promise<void> {
	const response = await postMultipartJson(
		target.completeUrl,
		{
			videoId: target.videoId,
			key: target.key,
			uploadId: target.uploadId,
			parts,
		},
		target.webhookSecret,
	);

	if (!response.ok) {
		throw await storageResponseError(
			"Multipart upload completion failed",
			response,
		);
	}
}

async function abortMultipartUpload(
	target: Extract<StorageUploadTarget, { type: "multipart" }>,
): Promise<void> {
	const response = await postMultipartJson(
		target.abortUrl,
		{
			videoId: target.videoId,
			key: target.key,
			uploadId: target.uploadId,
		},
		target.webhookSecret,
	);

	if (!response.ok) {
		throw await storageResponseError("Multipart upload abort failed", response);
	}
}

async function uploadFileMultipart(
	filePath: string,
	target: Extract<StorageUploadTarget, { type: "multipart" }>,
): Promise<void> {
	const fileHandle = file(filePath);
	const contentLength = fileHandle.size;
	const partSize = Math.floor(target.partSize);
	const parts: UploadedPart[] = [];

	try {
		if (contentLength <= 0) {
			throw new Error("Multipart upload requires a non-empty file");
		}

		if (partSize < MULTIPART_MIN_PART_SIZE_BYTES) {
			throw new Error("Multipart upload part size is too small");
		}

		const partCount = Math.ceil(contentLength / partSize);
		if (partCount > MULTIPART_MAX_PARTS) {
			throw new Error(
				`Multipart upload would require too many parts: ${partCount}/${MULTIPART_MAX_PARTS}`,
			);
		}

		for (let partNumber = 1; partNumber <= partCount; partNumber++) {
			const start = (partNumber - 1) * partSize;
			const end = Math.min(start + partSize, contentLength);
			const partLength = end - start;
			const url = await getMultipartPartUrl(target, partNumber, partLength);
			const etag = await uploadMultipartPart(
				url,
				fileHandle.slice(start, end),
				partLength,
				partNumber,
			);
			parts.push({ partNumber, etag, size: partLength });
		}

		await completeMultipartUpload(target, parts);
	} catch (error) {
		await abortMultipartUpload(target).catch((abortError) => {
			console.warn(
				"Multipart upload abort failed:",
				abortError instanceof Error ? abortError.message : abortError,
			);
		});
		throw error;
	}
}

export async function abortStorageUploadTarget(
	target: StorageUploadTarget,
): Promise<void> {
	if (target.type === "put") return;
	await abortMultipartUpload(target);
}

export async function uploadFileToStorage(
	filePath: string,
	target: StorageUploadTarget,
	contentType: string,
): Promise<void> {
	if (target.type === "put") {
		await uploadFileToS3(filePath, target.url, contentType);
		return;
	}

	await uploadFileMultipart(filePath, target);
}

export async function copyFileToMp4(
	inputPath: string,
): Promise<TempFileHandle> {
	const metadata = await probeVideoFile(inputPath);
	return await processVideo(inputPath, metadata, {
		maxWidth: metadata.width > 0 ? metadata.width : undefined,
		maxHeight: metadata.height > 0 ? metadata.height : undefined,
		remuxOnly: true,
	});
}

export async function muxMediaTracksToMp4(
	videoInputPath: string,
	audioInputPath: string | null,
	outputPath: string,
	abortSignal?: AbortSignal,
): Promise<void> {
	const args = audioInputPath
		? [
				"ffmpeg",
				"-hide_banner",
				"-y",
				"-i",
				videoInputPath,
				"-i",
				audioInputPath,
				"-map",
				"0:v:0",
				"-map",
				"1:a:0",
				"-c",
				"copy",
				"-shortest",
				"-movflags",
				"+faststart",
				outputPath,
			]
		: [
				"ffmpeg",
				"-hide_banner",
				"-y",
				"-i",
				videoInputPath,
				"-map",
				"0:v:0",
				"-c:v",
				"copy",
				"-an",
				"-movflags",
				"+faststart",
				outputPath,
			];

	await runFfmpegCommand(args, PROCESS_TIMEOUT_MS, abortSignal);
}
