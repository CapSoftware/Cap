import { readFile, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import {
	type DownloadToFileOptions,
	downloadToFile,
	LoomSegmentStatusError,
	type Semaphore,
} from "./fetch";

export class UnsupportedStreamError extends Error {}

export interface HlsVariant {
	bandwidth: number;
	pixels: number;
	audioGroup: string | null;
	uri: string;
	line: string;
}

export interface HlsAudioRendition {
	groupId: string;
	isDefault: boolean;
	uri: string | null;
	line: string;
}

export interface SelectedTracks {
	video: string;
	audio: string | null;
	masterLines: string[];
}

export function parseHlsAttributes(source: string): Record<string, string> {
	const attributes: Record<string, string> = {};
	const pattern = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
	for (const match of source.matchAll(pattern)) {
		const [, key, raw] = match;
		if (!key || raw === undefined) continue;
		attributes[key] =
			raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
	}
	return attributes;
}

function tagValue(line: string): string {
	return line.slice(line.indexOf(":") + 1);
}

export function selectHlsTracks(master: string): SelectedTracks | null {
	const lines = master.split(/\r?\n/);
	const variants: HlsVariant[] = [];
	const audio: HlsAudioRendition[] = [];
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index]?.trim() ?? "";
		if (line.startsWith("#EXT-X-STREAM-INF:")) {
			const attributes = parseHlsAttributes(tagValue(line));
			let uriIndex = index + 1;
			while (
				uriIndex < lines.length &&
				(!lines[uriIndex]?.trim() || lines[uriIndex]?.trim().startsWith("#"))
			)
				uriIndex++;
			const uri = lines[uriIndex]?.trim();
			if (!uri) continue;
			const [width, height] = (attributes.RESOLUTION ?? "0x0")
				.split("x")
				.map(Number);
			variants.push({
				bandwidth: Number(attributes.BANDWIDTH) || 0,
				pixels: (width || 0) * (height || 0),
				audioGroup: attributes.AUDIO ?? null,
				uri,
				line,
			});
			index = uriIndex;
		} else if (line.startsWith("#EXT-X-MEDIA:")) {
			const attributes = parseHlsAttributes(tagValue(line));
			if (attributes.TYPE !== "AUDIO" || !attributes["GROUP-ID"]) continue;
			audio.push({
				groupId: attributes["GROUP-ID"],
				isDefault: attributes.DEFAULT === "YES",
				uri: attributes.URI ?? null,
				line,
			});
		}
	}
	if (variants.length === 0) return null;
	const best = variants.reduce((current, candidate) =>
		candidate.bandwidth > current.bandwidth ||
		(candidate.bandwidth === current.bandwidth &&
			candidate.pixels > current.pixels)
			? candidate
			: current,
	);
	const group = best.audioGroup
		? audio.filter((rendition) => rendition.groupId === best.audioGroup)
		: [];
	const rendition =
		group.find((candidate) => candidate.isDefault && candidate.uri) ??
		group.find((candidate) => candidate.uri) ??
		null;
	const header = lines
		.map((line) => line.trim())
		.filter(
			(line) =>
				line === "#EXTM3U" ||
				line.startsWith("#EXT-X-VERSION") ||
				line.startsWith("#EXT-X-INDEPENDENT-SEGMENTS"),
		);
	return {
		video: best.uri,
		audio: rendition?.uri ?? null,
		masterLines: [
			...(header.length > 0 ? header : ["#EXTM3U"]),
			...(rendition ? [rendition.line] : []),
			best.line,
			best.uri,
		],
	};
}

export interface MediaPlaylistResource {
	url: string;
	lineIndex: number;
	attribute: boolean;
}

export function listMediaPlaylistResources(
	playlist: string,
): MediaPlaylistResource[] {
	const lines = playlist.split(/\r?\n/);
	const resources: MediaPlaylistResource[] = [];
	for (const [lineIndex, raw] of lines.entries()) {
		const line = raw.trim();
		if (!line) continue;
		if (line.startsWith("#EXT-X-KEY:")) {
			const method = parseHlsAttributes(tagValue(line)).METHOD;
			if (method && method !== "NONE")
				throw new UnsupportedStreamError("Encrypted HLS is not supported");
			continue;
		}
		if (line.startsWith("#EXT-X-BYTERANGE"))
			throw new UnsupportedStreamError("HLS byte ranges are not supported");
		if (line.startsWith("#EXT-X-MAP:")) {
			const attributes = parseHlsAttributes(tagValue(line));
			if (attributes.BYTERANGE)
				throw new UnsupportedStreamError("HLS byte ranges are not supported");
			if (!attributes.URI)
				throw new UnsupportedStreamError("HLS map is missing a URI");
			resources.push({ url: attributes.URI, lineIndex, attribute: true });
			continue;
		}
		if (line.startsWith("#")) continue;
		resources.push({ url: line, lineIndex, attribute: false });
	}
	if (!resources.some((resource) => !resource.attribute))
		throw new UnsupportedStreamError("HLS playlist has no media segments");
	return resources;
}

function segmentExtension(url: string): string {
	try {
		const extension = extname(new URL(url).pathname).toLowerCase();
		return /^\.[a-z0-9]{1,5}$/.test(extension) ? extension : ".bin";
	} catch {
		return ".bin";
	}
}

export interface PrefetchProgress {
	completedSegments: number;
	totalSegments: number;
	bytes: number;
}

export interface PrefetchOptions extends Omit<DownloadToFileOptions, "signal"> {
	signal: AbortSignal;
	jobSemaphore: Semaphore;
	globalSemaphore: Semaphore;
	priority?: boolean;
	maxBytes: number;
	onProgress?: (progress: PrefetchProgress) => void;
}

export interface PrefetchResult {
	masterPath: string;
	bytes: number;
	segments: number;
	skippedSeconds: number;
}

const MISSING_SEGMENT_FRACTION = 0.01;
const MISSING_SEGMENT_SECONDS = 6;

function segmentDuration(lines: string[], lineIndex: number): number {
	for (let index = lineIndex - 1; index >= 0; index--) {
		const line = lines[index]?.trim() ?? "";
		if (line.startsWith("#EXTINF:"))
			return Number.parseFloat(tagValue(line)) || 0;
		if (line && !line.startsWith("#")) return 0;
	}
	return 0;
}

function missingSegmentLimit(segments: number): number {
	return Math.max(1, Math.floor(segments * MISSING_SEGMENT_FRACTION));
}

export function canSkipMissingSegments(
	missingDurations: number[],
	segmentDurations: number[],
): boolean {
	if (missingDurations.length === 0) return true;
	if (missingDurations.length >= segmentDurations.length) return false;
	const total = segmentDurations.reduce((sum, value) => sum + value, 0);
	const missing = missingDurations.reduce((sum, value) => sum + value, 0);
	return (
		missingDurations.length <= missingSegmentLimit(segmentDurations.length) &&
		missing <=
			Math.max(MISSING_SEGMENT_SECONDS, total * MISSING_SEGMENT_FRACTION)
	);
}

function removeSegmentLines(lines: string[], lineIndex: number) {
	lines[lineIndex] = "";
	for (let index = lineIndex - 1; index >= 0; index--) {
		const line = lines[index]?.trim() ?? "";
		if (line.startsWith("#EXTINF:")) {
			lines[index] = "";
			return;
		}
		if (line && !line.startsWith("#")) return;
	}
}

export async function prefetchMaterializedHls(
	masterPath: string,
	workDir: string,
	options: PrefetchOptions,
): Promise<PrefetchResult> {
	const master = await readFile(masterPath, "utf8");
	const selection = selectHlsTracks(master) ?? {
		video: masterPath,
		audio: null,
		masterLines: [],
	};
	const tracks = [
		{ name: "video", path: selection.video },
		...(selection.audio ? [{ name: "audio", path: selection.audio }] : []),
	];
	const playlists = await Promise.all(
		tracks.map(async (track) => {
			const content = await readFile(track.path, "utf8");
			const resources = listMediaPlaylistResources(content);
			const lines = content.split(/\r?\n/);
			return {
				...track,
				lines,
				resources,
				durations: resources
					.filter((resource) => !resource.attribute)
					.map((resource) => segmentDuration(lines, resource.lineIndex)),
			};
		}),
	);
	const downloads = playlists.flatMap((playlist) =>
		playlist.resources.map((resource, index) => ({
			playlist,
			resource,
			duration: segmentDuration(playlist.lines, resource.lineIndex),
			path: join(
				workDir,
				`${playlist.name}-${String(index).padStart(6, "0")}${segmentExtension(resource.url)}`,
			),
		})),
	);
	const failure = new AbortController();
	const signal = AbortSignal.any([options.signal, failure.signal]);
	const progress: PrefetchProgress = {
		completedSegments: 0,
		totalSegments: downloads.length,
		bytes: 0,
	};
	const missing = new Set<(typeof downloads)[number]>();
	const playlistBytes = new Map<string, number>();
	const results = await Promise.allSettled(
		downloads.map((download) =>
			options.jobSemaphore
				.run(() =>
					options.globalSemaphore.run(async () => {
						signal.throwIfAborted();
						let bytes: number;
						try {
							bytes = await downloadToFile(
								download.resource.url,
								download.path,
								{ ...options, signal },
							);
						} catch (error) {
							if (
								!(error instanceof LoomSegmentStatusError) ||
								error.status !== 404 ||
								download.resource.attribute
							)
								throw error;
							missing.add(download);
							progress.completedSegments++;
							const lost = [...missing]
								.filter((entry) => entry.playlist === download.playlist)
								.map((entry) => entry.duration);
							if (!canSkipMissingSegments(lost, download.playlist.durations)) {
								const tooMany = new Error(
									`Loom is missing ${lost.length} of ${download.playlist.durations.length} ${download.playlist.name} segments`,
								);
								failure.abort(tooMany);
								throw tooMany;
							}
							return;
						}
						if (!download.resource.attribute)
							playlistBytes.set(
								download.playlist.name,
								(playlistBytes.get(download.playlist.name) ?? 0) + bytes,
							);
						progress.bytes += bytes;
						progress.completedSegments++;
						if (progress.bytes > options.maxBytes) {
							const error = new Error("Loom imports are limited to 10 GB");
							failure.abort(error);
							throw error;
						}
						options.onProgress?.({ ...progress });
					}, options.priority),
				)
				.catch((error) => {
					failure.abort(error);
					throw error;
				}),
		),
	);
	const rejected = results.find(
		(result): result is PromiseRejectedResult => result.status === "rejected",
	);
	if (rejected) {
		options.signal.throwIfAborted();
		throw failure.signal.reason ?? rejected.reason;
	}
	for (const download of downloads) {
		if (missing.has(download)) {
			removeSegmentLines(download.playlist.lines, download.resource.lineIndex);
			continue;
		}
		const line = download.playlist.lines[download.resource.lineIndex] ?? "";
		download.playlist.lines[download.resource.lineIndex] = download.resource
			.attribute
			? line.replace(`URI="${download.resource.url}"`, `URI="${download.path}"`)
			: download.path;
	}
	const localPlaylists = new Map<string, string>();
	for (const playlist of playlists) {
		const localPath = join(workDir, `${playlist.name}-local.m3u8`);
		await writeFile(localPath, playlist.lines.join("\n"));
		localPlaylists.set(playlist.path, localPath);
	}
	const localMasterPath = join(workDir, "master-local.m3u8");
	const audioPlaylist = selection.audio
		? localPlaylists.get(selection.audio)
		: undefined;
	const audioOnly =
		audioPlaylist !== undefined &&
		(playlistBytes.get("video") ?? 0) === 0 &&
		(playlistBytes.get("audio") ?? 0) > 0;
	const skippedSeconds = [...missing]
		.filter(
			(download) => download.playlist.name === (audioOnly ? "audio" : "video"),
		)
		.reduce((sum, download) => sum + download.duration, 0);
	if (audioOnly && audioPlaylist) {
		await writeFile(localMasterPath, await readFile(audioPlaylist, "utf8"));
	} else if (selection.masterLines.length > 0) {
		await writeFile(
			localMasterPath,
			selection.masterLines
				.map((line) => {
					for (const [remote, local] of localPlaylists) {
						if (line === remote) return local;
						if (line.includes(`URI="${remote}"`))
							return line.replace(`URI="${remote}"`, `URI="${local}"`);
					}
					return line;
				})
				.join("\n"),
		);
	} else {
		await writeFile(
			localMasterPath,
			await readFile(localPlaylists.get(masterPath) ?? masterPath, "utf8"),
		);
	}
	return {
		masterPath: localMasterPath,
		bytes: progress.bytes,
		segments: downloads.length,
		skippedSeconds,
	};
}
