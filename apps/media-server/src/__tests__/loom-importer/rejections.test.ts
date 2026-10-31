import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getJob, updateJob } from "../../lib/job-manager";
import {
	createLoomImporter,
	loadImporterSettings,
} from "../../loom-importer/app";
import * as importJob from "../../loom-importer/job";

const packageRoot = resolve(import.meta.dir, "../../..");
const importerEntry = resolve(packageRoot, "src/loom-importer/index.ts");

describe("Loom importer process", () => {
	test("logs a stray rejection and keeps running", async () => {
		const dir = await mkdtemp(join(packageRoot, ".loom-importer-entry-"));
		try {
			const script = join(dir, "script.ts");
			await writeFile(
				script,
				`
				await import(${JSON.stringify(importerEntry)});
				setTimeout(() => {
					void Promise.reject(new Error("stray import failure"));
				}, 10);
				setTimeout(() => {
					console.log("alive");
					process.exit(0);
				}, 200);
				`,
			);
			const proc = Bun.spawn([process.execPath, script], {
				cwd: packageRoot,
				env: {
					...process.env,
					LOOM_IMPORTER_WORK_DIR: join(dir, "work"),
				},
				stdout: "pipe",
				stderr: "pipe",
			});
			const [exitCode, stdout, stderr] = await Promise.all([
				proc.exited,
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
			]);
			expect(exitCode).toBe(0);
			expect(stdout).toContain("alive");
			const event = JSON.parse(
				stderr
					.split("\n")
					.find((line) => line.includes('"unhandled_rejection"')) ?? "{}",
			);
			expect(event.message).toBe("stray import failure");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("Loom importer job runner", () => {
	let root: string;

	beforeAll(async () => {
		process.env.MEDIA_SERVER_WEBHOOK_SECRET = "importer-secret";
		root = await mkdtemp(join(tmpdir(), "loom-importer-rejections-"));
	});

	afterAll(async () => {
		if (root) await rm(root, { recursive: true, force: true });
	});

	test("records an import that rejects on its job and keeps running queued imports", async () => {
		const runs: string[] = [];
		let releaseBroken = () => {};
		const brokenGate = new Promise<void>((resolve) => {
			releaseBroken = resolve;
		});
		const run = spyOn(importJob, "runLoomImport").mockImplementation(
			async (job, request) => {
				runs.push(request.videoId);
				if (request.videoId === "broken") {
					await brokenGate;
					throw new Error("import rejected after cleanup");
				}
				updateJob(job.jobId, { phase: "complete", progress: 100 });
			},
		);
		const errors = spyOn(console, "error").mockImplementation(() => {});
		try {
			const config = loadImporterSettings({
				LOOM_IMPORTER_WORK_DIR: root,
				LOOM_IMPORTER_ALLOWED_HOSTS: "127.0.0.1",
				LOOM_IMPORTER_MAX_JOBS: "1",
				LOOM_IMPORTER_MIN_FREE_GB: "1",
			});
			const importer = createLoomImporter(config);
			const post = async (videoId: string) => {
				const response = await importer.app.request(
					"/loom-importer/video/import",
					{
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							"x-media-server-secret": "importer-secret",
						},
						body: JSON.stringify({
							videoId,
							userId: "user",
							videoUrl: "http://127.0.0.1:9/master.m3u8",
							outputPresignedUrl: "http://127.0.0.1:9/result.mp4",
						}),
					},
				);
				return ((await response.json()) as { jobId: string }).jobId;
			};

			const brokenId = await post("broken");
			const nextId = await post("next");
			expect(importer.stats()).toEqual({ running: 1, queued: 1 });
			releaseBroken();
			const deadline = Date.now() + 5_000;
			while (getJob(nextId)?.phase !== "complete" && Date.now() < deadline)
				await Bun.sleep(10);
			await Bun.sleep(20);

			expect(runs).toEqual(["broken", "next"]);
			expect(getJob(brokenId)).toMatchObject({
				phase: "error",
				progress: 0,
				error: "import rejected after cleanup",
			});
			expect(getJob(nextId)?.phase).toBe("complete");
			expect(importer.stats()).toEqual({ running: 0, queued: 0 });
			expect(errors).toHaveBeenCalled();
		} finally {
			errors.mockRestore();
			run.mockRestore();
		}
	});
});
