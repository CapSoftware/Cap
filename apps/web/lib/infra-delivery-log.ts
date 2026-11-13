import { pipeline, type Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { createGunzip } from "node:zlib";

export const DELIVERY_RENDITION_TIERS = [
	"360p",
	"720p",
	"1080p",
	"1440p",
	"2160p",
] as const;

export type DeliveryRenditionTier = (typeof DELIVERY_RENDITION_TIERS)[number];
export type DeliveryTier = DeliveryRenditionTier | "audio";
export type DeliveryKind = DeliveryTier | "mp4";

export interface DeliveryRequest {
	day: string;
	appId: string;
	videoId: string;
	kind: DeliveryKind;
	key: string;
	rangeStart: number;
	bytes: number;
	bodyBytes: number;
}

export type DeliveryPart = [
	day: string,
	appId: string,
	videoId: string,
	tier: DeliveryTier,
	requests: number,
	bytes: number,
	milliseconds: number,
];

const ID = "[A-Za-z0-9_-]{1,64}";
const DELIVERY_PATH = new RegExp(
	`^/(developer/(${ID})/(${ID})/${ID}/${ID}/(?:hls/(360p|720p|1080p|1440p|2160p|audio)\\.m4s|(video)\\.mp4))$`,
);
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DELIVERED_STATUSES = new Set(["200", "206"]);
const TIERS = new Set<string>(DELIVERY_RENDITION_TIERS);

function field(record: Record<string, unknown>, name: string): string | null {
	const value = record[name];
	if (typeof value === "string") return value;
	if (typeof value === "number") return String(value);
	return null;
}

function count(value: string | null): number | null {
	if (value === null || !/^\d{1,15}$/.test(value)) return null;
	return Number(value);
}

export function parseDeliveryRecord(
	record: Record<string, unknown>,
): DeliveryRequest | null {
	const status = field(record, "sc-status");
	if (!status || !DELIVERED_STATUSES.has(status)) return null;
	if (field(record, "cs-method") !== "GET") return null;
	if (field(record, "x-edge-result-type") === "Error") return null;
	const day = field(record, "date");
	if (!day || !DAY.test(day)) return null;
	const path = field(record, "cs-uri-stem");
	const match = path ? DELIVERY_PATH.exec(path) : null;
	if (!match) return null;
	const [, key, appId, videoId, tier, mp4] = match;
	if (!key || !appId || !videoId) return null;
	const bytes = count(field(record, "sc-bytes"));
	if (!bytes) return null;
	const contentLength = count(field(record, "sc-content-len"));
	const rangeStart = count(field(record, "sc-range-start"));
	const rangeEnd = count(field(record, "sc-range-end"));
	const rangeLength =
		rangeStart !== null && rangeEnd !== null && rangeEnd >= rangeStart
			? rangeEnd - rangeStart + 1
			: null;
	return {
		day,
		appId,
		videoId,
		kind: mp4 ? "mp4" : (tier as DeliveryTier),
		key,
		rangeStart: rangeStart ?? 0,
		bytes,
		bodyBytes: Math.min(
			bytes,
			contentLength ?? Number.POSITIVE_INFINITY,
			rangeLength ?? Number.POSITIVE_INFINITY,
		),
	};
}

export function parseDeliveryLine(line: string): DeliveryRequest | null {
	if (!line.includes("/developer/")) return null;
	let record: unknown;
	try {
		record = JSON.parse(line);
	} catch {
		return null;
	}
	if (!record || typeof record !== "object" || Array.isArray(record)) {
		return null;
	}
	return parseDeliveryRecord(record as Record<string, unknown>);
}

export interface HlsSegment {
	start: number;
	end: number;
	duration: number;
}

export function parseHlsByteRanges(
	playlist: string,
	mediaName: string,
): HlsSegment[] | null {
	const segments: HlsSegment[] = [];
	let duration: number | null = null;
	let range: { start: number; length: number } | null = null;
	let nextOffset = 0;
	for (const raw of playlist.split(/\r?\n/)) {
		const line = raw.trim();
		if (line.length === 0) continue;
		const extinf = /^#EXTINF:([0-9.]+)/.exec(line);
		if (extinf) {
			duration = Number(extinf[1]);
			continue;
		}
		const byterange = /^#EXT-X-BYTERANGE:(\d+)(?:@(\d+))?$/.exec(line);
		if (byterange) {
			const start =
				byterange[2] === undefined ? nextOffset : Number(byterange[2]);
			range = { start, length: Number(byterange[1]) };
			continue;
		}
		if (line.startsWith("#")) continue;
		if (
			line !== mediaName ||
			range === null ||
			duration === null ||
			!Number.isFinite(duration)
		) {
			return null;
		}
		segments.push({
			start: range.start,
			end: range.start + range.length,
			duration,
		});
		nextOffset = range.start + range.length;
		range = null;
		duration = null;
	}
	if (segments.length === 0) return null;
	return segments.sort((a, b) => a.start - b.start);
}

export function hlsSecondsDelivered(
	segments: HlsSegment[],
	start: number,
	length: number,
): number {
	const end = start + length;
	let low = 0;
	let high = segments.length;
	while (low < high) {
		const mid = (low + high) >> 1;
		if ((segments[mid]?.end ?? 0) <= start) low = mid + 1;
		else high = mid;
	}
	let seconds = 0;
	for (let i = low; i < segments.length; i++) {
		const segment = segments[i];
		if (!segment || segment.start >= end) break;
		const overlap = Math.min(end, segment.end) - Math.max(start, segment.start);
		if (overlap > 0) {
			seconds += (segment.duration * overlap) / (segment.end - segment.start);
		}
	}
	return seconds;
}

export interface DeliveryMp4 {
	appId: string;
	tier: DeliveryRenditionTier;
	bytesPerSecond: number | null;
}

export function deliveryMp4Rate(row: {
	appId: string;
	duration: number | null;
	renditions: unknown;
	processing: unknown;
}): DeliveryMp4 | null {
	let tier: DeliveryRenditionTier | null = null;
	let pixels = 0;
	for (const rendition of Array.isArray(row.renditions) ? row.renditions : []) {
		if (!rendition || typeof rendition !== "object") continue;
		const { name, width, height } = rendition as Record<string, unknown>;
		if (
			typeof name !== "string" ||
			!TIERS.has(name) ||
			typeof width !== "number" ||
			typeof height !== "number"
		) {
			continue;
		}
		if (width * height > pixels) {
			pixels = width * height;
			tier = name as DeliveryRenditionTier;
		}
	}
	if (!tier) return null;
	const mp4Bytes =
		row.processing && typeof row.processing === "object"
			? (row.processing as { bytes?: { mp4?: unknown } }).bytes?.mp4
			: null;
	const duration = row.duration ?? 0;
	return {
		appId: row.appId,
		tier,
		bytesPerSecond:
			typeof mp4Bytes === "number" && mp4Bytes > 0 && duration > 0
				? mp4Bytes / duration
				: null,
	};
}

export interface DeliveryResolver {
	hls(playlistKey: string): Promise<HlsSegment[] | null>;
	mp4(request: { videoId: string; key: string }): Promise<DeliveryMp4 | null>;
}

export function cachedDeliveryResolver(
	resolver: DeliveryResolver,
): DeliveryResolver {
	const playlists = new Map<string, Promise<HlsSegment[] | null>>();
	const videos = new Map<string, Promise<DeliveryMp4 | null>>();
	const remember = <T>(
		cache: Map<string, Promise<T>>,
		key: string,
		load: () => Promise<T>,
	) => {
		let entry = cache.get(key);
		if (!entry) {
			entry = load();
			cache.set(key, entry);
			entry.catch(() => cache.delete(key));
		}
		return entry;
	};
	return {
		hls: (key) => remember(playlists, key, () => resolver.hls(key)),
		mp4: (request) =>
			remember(videos, request.videoId, () => resolver.mp4(request)),
	};
}

export async function deliveredSeconds(
	request: DeliveryRequest,
	resolver: DeliveryResolver,
): Promise<{ tier: DeliveryTier; seconds: number } | null> {
	if (request.kind === "audio") return { tier: "audio", seconds: 0 };
	if (request.kind === "mp4") {
		const mp4 = await resolver.mp4(request);
		if (!mp4 || mp4.appId !== request.appId) return null;
		return {
			tier: mp4.tier,
			seconds: mp4.bytesPerSecond ? request.bodyBytes / mp4.bytesPerSecond : 0,
		};
	}
	const segments = await resolver.hls(request.key.replace(/\.m4s$/, ".m3u8"));
	return {
		tier: request.kind,
		seconds: segments
			? hlsSecondsDelivered(segments, request.rangeStart, request.bodyBytes)
			: 0,
	};
}

export class DeliveryTally {
	private readonly parts = new Map<string, DeliveryPart>();

	add(
		request: DeliveryRequest,
		delivered: { tier: DeliveryTier; seconds: number },
	) {
		const key = `${request.day}\0${request.appId}\0${request.videoId}\0${delivered.tier}`;
		const part = this.parts.get(key);
		if (part) {
			part[4] += 1;
			part[5] += request.bytes;
			part[6] += delivered.seconds * 1000;
			return;
		}
		this.parts.set(key, [
			request.day,
			request.appId,
			request.videoId,
			delivered.tier,
			1,
			request.bytes,
			delivered.seconds * 1000,
		]);
	}

	toParts(): DeliveryPart[] {
		return [...this.parts.values()].map((part) => {
			const rounded = [...part] as DeliveryPart;
			rounded[6] = Math.round(part[6]);
			return rounded;
		});
	}
}

export interface MeteredLogFile {
	parts: DeliveryPart[];
	lines: number;
	delivered: number;
}

export async function meterDeliveryLog(
	gzipped: Readable,
	resolver: DeliveryResolver,
): Promise<MeteredLogFile> {
	const tally = new DeliveryTally();
	let lines = 0;
	let delivered = 0;
	const take = async (line: string) => {
		if (line.length === 0) return;
		lines += 1;
		const request = parseDeliveryLine(line);
		if (!request) return;
		const seconds = await deliveredSeconds(request, resolver);
		if (!seconds) return;
		delivered += 1;
		tally.add(request, seconds);
	};
	const unzipped = pipeline(gzipped, createGunzip(), () => {});
	const decoder = new StringDecoder("utf8");
	let pending = "";
	for await (const chunk of unzipped) {
		pending += decoder.write(chunk as Buffer);
		let start = 0;
		for (;;) {
			const end = pending.indexOf("\n", start);
			if (end === -1) break;
			await take(pending.slice(start, end).trim());
			start = end + 1;
		}
		pending = pending.slice(start);
	}
	pending += decoder.end();
	await take(pending.trim());
	return { parts: tally.toParts(), lines, delivered };
}

const PART_TIERS = new Set<string>([...DELIVERY_RENDITION_TIERS, "audio"]);

function isCount(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function readDeliveryParts(value: unknown): DeliveryPart[] {
	if (!Array.isArray(value)) return [];
	return value.filter(
		(part): part is DeliveryPart =>
			Array.isArray(part) &&
			part.length === 7 &&
			typeof part[0] === "string" &&
			DAY.test(part[0]) &&
			typeof part[1] === "string" &&
			typeof part[2] === "string" &&
			typeof part[3] === "string" &&
			PART_TIERS.has(part[3]) &&
			isCount(part[4]) &&
			isCount(part[5]) &&
			isCount(part[6]),
	);
}
