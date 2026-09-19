import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareNativeEditorProject } from "../../lib/editor-native";

const hasNativeBinary = Boolean(process.env.CAP_WEB_EDITOR_PREPARE_BIN);

function run(command: string, args: string[]) {
	const result = spawnSync(command, args, {
		encoding: "buffer",
		timeout: 30_000,
		maxBuffer: 1024 * 1024,
	});
	if (result.status !== 0) {
		throw new Error(`${command} failed: ${result.stderr.toString("utf8")}`);
	}
	return result.stdout;
}

function mediaDuration(path: string) {
	const result = run("ffprobe", [
		"-v",
		"error",
		"-show_entries",
		"format=duration",
		"-of",
		"default=noprint_wrappers=1:nokey=1",
		path,
	]);
	return Number(result.toString("utf8"));
}

function centerColor(path: string, time: number) {
	return [
		...run("ffmpeg", [
			"-v",
			"error",
			"-ss",
			String(time),
			"-i",
			path,
			"-frames:v",
			"1",
			"-vf",
			"crop=1:1:iw/2:ih/2,format=rgb24",
			"-f",
			"rawvideo",
			"pipe:1",
		]),
	];
}

test.skipIf(!hasNativeBinary)(
	"preserved legacy MP4 keep ranges replay in a native Studio export",
	async () => {
		const root = await mkdtemp(join(tmpdir(), "cap-legacy-editor-replay-"));
		const sourcePath = join(root, "original.mp4");
		const renderedPath = join(root, "edited.mp4");
		let cleanup: (() => Promise<void>) | null = null;
		try {
			run("ffmpeg", [
				"-v",
				"error",
				"-f",
				"lavfi",
				"-i",
				"color=c=red:s=320x180:r=30:d=2",
				"-f",
				"lavfi",
				"-i",
				"color=c=blue:s=320x180:r=30:d=2",
				"-f",
				"lavfi",
				"-i",
				"sine=frequency=440:sample_rate=48000:duration=4",
				"-filter_complex",
				"[0:v][1:v]concat=n=2:v=1:a=0[v]",
				"-map",
				"[v]",
				"-map",
				"2:a",
				"-c:v",
				"libx264",
				"-pix_fmt",
				"yuv420p",
				"-c:a",
				"aac",
				sourcePath,
			]);
			const originalBytes = await readFile(sourcePath);
			const sourceDuration = mediaDuration(sourcePath);
			expect(sourceDuration).toBeCloseTo(4, 1);
			const spec = {
				version: 1 as const,
				sourceDuration,
				keepRanges: [
					{ start: 0.2, end: 0.8 },
					{ start: 2.2, end: 2.8 },
				],
			};
			const input = {
				title: "Older trimmed recording",
				display: {
					path: sourcePath,
					contentType: "video/mp4" as const,
					size: (await stat(sourcePath)).size,
					fps: 30,
				},
				mixedAudioInDisplay: true,
				legacyEditSpec: spec,
			};
			const project = await prepareNativeEditorProject(input);
			cleanup = project.cleanup;
			const configPath = join(project.path, "project-config.json");
			const config = JSON.parse(await readFile(configPath, "utf8")) as {
				timeline: { segments: Array<{ start: number; end: number }> };
			};
			expect(
				config.timeline.segments.map(({ start, end }) => [start, end]),
			).toEqual([
				[0.2, 0.8],
				[2.2, 2.8],
			]);
			const settingsPath = join(root, "settings.json");
			await writeFile(
				settingsPath,
				JSON.stringify({
					format: "Mp4",
					fps: 30,
					resolution_base: { x: 640, y: 360 },
					compression: "Social",
					custom_bpp: null,
					force_ffmpeg_decoder: true,
					optimize_filesize: false,
				}),
			);
			run(process.env.CAP_WEB_EDITOR_PREPARE_BIN ?? "", [
				"export",
				project.path,
				configPath,
				settingsPath,
				renderedPath,
			]);
			expect(mediaDuration(renderedPath)).toBeCloseTo(1.2, 1);
			const red = centerColor(renderedPath, 0.3);
			const blue = centerColor(renderedPath, 0.9);
			expect(red[0]).toBeGreaterThan(130);
			expect(red[2]).toBeLessThan(100);
			expect(blue[0]).toBeLessThan(100);
			expect(blue[2]).toBeGreaterThan(130);
			expect(await readFile(sourcePath)).toEqual(originalBytes);
			const reopened = await prepareNativeEditorProject({
				...input,
				projectConfig: config as unknown as Record<string, unknown>,
			});
			try {
				const restored = JSON.parse(
					await readFile(join(reopened.path, "project-config.json"), "utf8"),
				) as typeof config;
				expect(restored.timeline.segments).toEqual(config.timeline.segments);
			} finally {
				await reopened.cleanup();
			}
		} finally {
			await cleanup?.();
			await rm(root, { recursive: true, force: true });
		}
	},
	30_000,
);
