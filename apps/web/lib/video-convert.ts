import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getFfmpegPath } from "@/lib/audio-extract";

export interface VideoConversionResult {
	filePath: string;
	mimeType: string;
	cleanup: () => Promise<void>;
}

function runFfmpeg(args: string[]): Promise<void> {
	const ffmpeg = getFfmpegPath();

	return new Promise((resolve, reject) => {
		const proc = spawn(ffmpeg, args, { stdio: ["ignore", "ignore", "pipe"] });

		let stderr = "";

		proc.stderr?.on("data", (data: Buffer) => {
			stderr += data.toString();
		});

		proc.on("error", (err: Error) => {
			reject(new Error(`Video conversion failed: ${err.message}`));
		});

		proc.on("close", (code: number | null) => {
			if (code === 0) {
				resolve();
				return;
			}

			reject(new Error(`Video conversion failed with code ${code}: ${stderr}`));
		});
	});
}

function isHlsUrl(url: string): boolean {
	return (url.split("?")[0] ?? "").toLowerCase().endsWith(".m3u8");
}

function isMpdUrl(url: string): boolean {
	return (url.split("?")[0] ?? "").toLowerCase().endsWith(".mpd");
}

function withQuery(url: string, query: string): string {
	if (!query || url.includes("?")) {
		return url;
	}

	return `${url}${query}`;
}

function resolveResourceUrl(
	resource: string,
	baseUrl: string,
	query: string,
): string {
	if (resource.startsWith("http://") || resource.startsWith("https://")) {
		return withQuery(resource, query);
	}

	return withQuery(new URL(resource, baseUrl).toString(), query);
}

async function materializeHlsPlaylist(
	playlistUrl: string,
	dirPath: string,
	cache: Map<string, string>,
): Promise<string> {
	const cached = cache.get(playlistUrl);
	if (cached) {
		return cached;
	}

	const response = await fetch(playlistUrl);
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

			if (!trimmed) {
				return line;
			}

			if (!trimmed.startsWith("#")) {
				const resolved = resolveResourceUrl(trimmed, baseUrl, query);

				if (isHlsUrl(resolved)) {
					return await materializeHlsPlaylist(resolved, dirPath, cache);
				}

				return resolved;
			}

			if (!line.includes('URI="')) {
				return line;
			}

			const matches = [...line.matchAll(/URI="([^"]+)"/g)];
			let rewritten = line;

			for (const match of matches) {
				const original = match[1];
				if (!original) {
					continue;
				}

				const resolved = resolveResourceUrl(original, baseUrl, query);
				const replacement = isHlsUrl(resolved)
					? await materializeHlsPlaylist(resolved, dirPath, cache)
					: resolved;

				rewritten = rewritten.replace(
					`URI="${original}"`,
					`URI="${replacement}"`,
				);
			}

			return rewritten;
		}),
	);

	await fs.writeFile(filePath, lines.join("\n"));
	return filePath;
}

async function materializeMpdManifest(
	manifestUrl: string,
	dirPath: string,
): Promise<string> {
	const response = await fetch(manifestUrl);
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

	const rewritten = content.replace(
		/(initialization|media)="([^"]+)"/g,
		(_, attribute: string, resource: string) => {
			const resolved = resolveResourceUrl(resource, baseUrl, query);
			return `${attribute}="${resolved}"`;
		},
	);

	await fs.writeFile(filePath, rewritten);
	return filePath;
}

async function materializeStreamingInput(
	videoUrl: string,
	dirPath: string,
): Promise<string> {
	if (isHlsUrl(videoUrl)) {
		return await materializeHlsPlaylist(videoUrl, dirPath, new Map());
	}

	if (isMpdUrl(videoUrl)) {
		return await materializeMpdManifest(videoUrl, dirPath);
	}

	return videoUrl;
}

async function convertRemoteVideoToMp4FileInternal(
	videoUrl: string,
	outputPath: string,
): Promise<void> {
	try {
		await runFfmpeg([
			"-y",
			"-i",
			videoUrl,
			"-c",
			"copy",
			"-movflags",
			"+faststart",
			outputPath,
		]);
	} catch {
		await runFfmpeg([
			"-y",
			"-i",
			videoUrl,
			"-c:v",
			"libx264",
			"-preset",
			"veryfast",
			"-pix_fmt",
			"yuv420p",
			"-c:a",
			"aac",
			"-b:a",
			"128k",
			"-movflags",
			"+faststart",
			outputPath,
		]);
	}
}

export async function convertRemoteVideoToMp4(
	videoUrl: string,
): Promise<VideoConversionResult> {
	const dirPath = await fs.mkdtemp(join(tmpdir(), "cap-video-"));
	const filePath = join(dirPath, `video-${randomUUID()}.mp4`);

	try {
		const inputPath = await materializeStreamingInput(videoUrl, dirPath);
		await convertRemoteVideoToMp4FileInternal(inputPath, filePath);

		return {
			filePath,
			mimeType: "video/mp4",
			cleanup: async () => {
				try {
					await fs.rm(dirPath, { force: true, recursive: true });
				} catch {}
			},
		};
	} catch (error) {
		await fs.rm(dirPath, { force: true, recursive: true }).catch(() => {});
		throw error;
	}
}

export async function convertRemoteVideoToMp4Buffer(
	videoUrl: string,
): Promise<Buffer> {
	const result = await convertRemoteVideoToMp4(videoUrl);

	try {
		return await fs.readFile(result.filePath);
	} finally {
		await result.cleanup();
	}
}
