import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { downloadEditorMedia } from "../../lib/editor-media";

const runFile = promisify(execFile);

test("finalizes a live WebM source before native editor preparation", async () => {
	const root = await mkdtemp(join(tmpdir(), "cap-editor-live-webm-"));
	const sourcePath = join(root, "live.webm");
	const previousHttpMedia = process.env.CAP_WEB_EDITOR_ALLOW_HTTP_MEDIA;
	let server: ReturnType<typeof Bun.serve> | null = null;
	try {
		await runFile("ffmpeg", [
			"-hide_banner",
			"-loglevel",
			"error",
			"-f",
			"lavfi",
			"-i",
			"testsrc2=size=160x90:rate=15:duration=2",
			"-c:v",
			"libvpx",
			"-f",
			"webm",
			"-live",
			"1",
			sourcePath,
		]);
		server = Bun.serve({
			port: 0,
			fetch: () => new Response(Bun.file(sourcePath)),
		});
		process.env.CAP_WEB_EDITOR_ALLOW_HTTP_MEDIA = "1";
		const downloaded = await downloadEditorMedia({
			url: `http://127.0.0.1:${server.port}/live.webm`,
			contentType: "video/webm",
			size: (await stat(sourcePath)).size,
		});
		try {
			const { stdout } = await runFile("ffprobe", [
				"-v",
				"error",
				"-show_entries",
				"format=duration",
				"-of",
				"default=noprint_wrappers=1:nokey=1",
				downloaded.path,
			]);
			expect(Number(stdout.trim())).toBeGreaterThan(1.8);
			expect(downloaded.size).toBe((await stat(downloaded.path)).size);
		} finally {
			await downloaded.cleanup();
		}
	} finally {
		server?.stop(true);
		if (previousHttpMedia === undefined) {
			delete process.env.CAP_WEB_EDITOR_ALLOW_HTTP_MEDIA;
		} else {
			process.env.CAP_WEB_EDITOR_ALLOW_HTTP_MEDIA = previousHttpMedia;
		}
		await rm(root, { recursive: true, force: true });
	}
});
