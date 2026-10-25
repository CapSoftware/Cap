import { readFile, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import {
	type DownloadToFileOptions,
	downloadToFile,
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
			return {
				...track,
				lines: content.split(/\r?\n/),
				resources: listMediaPlaylistResources(content),
			};
		}),
	);
	const downloads = playlists.flatMap((playlist) =>
		playlist.resources.map((resource, index) => ({
			playlist,
			resource,
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
	const results = await Promise.allSettled(
		downloads.map((download) =>
			options.jobSemaphore
				.run(() =>
					options.globalSemaphore.run(async () => {
						signal.throwIfAborted();
						const bytes = await downloadToFile(
							download.resource.url,
							download.path,
							{ ...options, signal },
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
	if (selection.masterLines.length > 0) {
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
	};
}
