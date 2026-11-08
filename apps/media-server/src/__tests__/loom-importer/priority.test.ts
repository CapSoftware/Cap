import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getJob } from "../../lib/job-manager";
import {
	createLoomImporter,
	loadImporterSettings,
} from "../../loom-importer/app";
import { Semaphore } from "../../loom-importer/fetch";

describe("Semaphore priority", () => {
	test("hands a freed permit to priority waiters before earlier normal waiters", async () => {
		const semaphore = new Semaphore(1);
		const order: string[] = [];
		let releaseHolder: () => void = () => {};
		const holder = semaphore.run(
			() =>
				new Promise<void>((resolve) => {
					releaseHolder = resolve;
				}),
		);
		const waiters = [
			semaphore.run(async () => {
				order.push("bulk-1");
			}),
			semaphore.run(async () => {
				order.push("bulk-2");
			}),
			semaphore.run(async () => {
				order.push("customer");
			}, true),
		];
		releaseHolder();
		await Promise.all([holder, ...waiters]);
		expect(order).toEqual(["customer", "bulk-1", "bulk-2"]);
	});

	test("keeps first-in first-out order when nobody asks for priority", async () => {
		const semaphore = new Semaphore(1);
		const order: number[] = [];
		await Promise.all(
			Array.from({ length: 5 }, (_, index) =>
				semaphore.run(async () => {
					order.push(index);
					await Bun.sleep(1);
				}),
			),
		);
		expect(order).toEqual([0, 1, 2, 3, 4]);
	});
});

describe("Loom importer lanes", () => {
	let root: string;
	let source: ReturnType<typeof Bun.serve>;
	const releases = new Map<string, () => void>();
	const gates = new Map<string, Promise<void>>();
	const started = new Set<string>();
	const jobIds = new Map<string, string>();

	beforeAll(async () => {
		process.env.MEDIA_SERVER_WEBHOOK_SECRET = "importer-secret";
		root = await mkdtemp(join(tmpdir(), "loom-importer-lanes-"));
		source = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			async fetch(request) {
				const videoId = new URL(request.url).pathname.split("/")[1] ?? "";
				started.add(videoId);
				await gates.get(videoId);
				return new Response("#EXTM3U\n#EXT-X-ENDLIST");
			},
		});
	});

	afterAll(async () => {
		for (const release of releases.values()) release();
		source?.stop(true);
		if (root) await rm(root, { recursive: true, force: true });
	});

	type Importer = ReturnType<typeof createLoomImporter>;

	function importer(env: Record<string, string>) {
		const config = loadImporterSettings({
			LOOM_IMPORTER_WORK_DIR: root,
			LOOM_IMPORTER_ALLOWED_HOSTS: "127.0.0.1",
			LOOM_IMPORTER_MIN_FREE_GB: "1",
			...env,
		});
		config.settings.minFreeBytes = 1;
		return createLoomImporter(config);
	}

	async function post(
		{ app }: Importer,
		videoId: string,
		importPriority?: "customer" | "bulk",
	) {
		gates.set(
			videoId,
			new Promise<void>((resolve) => releases.set(videoId, resolve)),
		);
		const response = await app.request("/loom-importer/video/import", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-media-server-secret": "importer-secret",
			},
			body: JSON.stringify({
				videoId,
				userId: "user",
				videoUrl: `http://127.0.0.1:${source.port}/${videoId}/master.m3u8`,
				outputPresignedUrl: "http://127.0.0.1:9/result.mp4",
				...(importPriority ? { importPriority } : {}),
			}),
		});
		if (response.ok)
			jobIds.set(videoId, ((await response.json()) as { jobId: string }).jobId);
		return response;
	}

	const isFinished = (videoId: string) => {
		const jobId = jobIds.get(videoId);
		const phase = jobId ? getJob(jobId)?.phase : undefined;
		return phase === "error" || phase === "complete" || phase === "cancelled";
	};

	async function waitFor(condition: () => boolean) {
		const deadline = Date.now() + 10_000;
		while (!condition() && Date.now() < deadline) await Bun.sleep(10);
		expect(condition()).toBe(true);
	}

	async function expectRunning(
		importer: Importer,
		ids: string[],
		runningCustomer: number,
	) {
		await waitFor(() => ids.every((id) => started.has(id)));
		await Bun.sleep(100);
		const status = (await (
			await importer.app.request("/loom-importer/video/status", {
				headers: { "x-media-server-secret": "importer-secret" },
			})
		).json()) as { runningCustomer: number };
		expect(importer.stats().running).toBe(ids.length);
		expect(status.runningCustomer).toBe(runningCustomer);
	}

	function expectWaiting(ids: string[]) {
		for (const id of ids) expect(started.has(id)).toBe(false);
	}

	async function finish(videoId: string) {
		releases.get(videoId)?.();
		await waitFor(() => isFinished(videoId));
	}

	async function settle(importer: Importer) {
		for (const release of releases.values()) release();
		await waitFor(
			() => importer.stats().running + importer.stats().queued === 0,
		);
	}

	test("bulk imports keep every general slot and never take a customer slot", async () => {
		const box = importer({
			LOOM_IMPORTER_MAX_JOBS: "2",
			LOOM_IMPORTER_CUSTOMER_JOBS: "3",
		});
		for (const id of ["b1", "b2", "b3", "b4"]) await post(box, id, "bulk");
		await expectRunning(box, ["b1", "b2"], 0);
		expectWaiting(["b3", "b4"]);
		expect(box.stats().queued).toBe(2);
		await finish("b1");
		await expectRunning(box, ["b2", "b3"], 0);
		expectWaiting(["b4"]);
		await settle(box);
	});

	test("imports without a lane run as bulk", async () => {
		const box = importer({
			LOOM_IMPORTER_MAX_JOBS: "1",
			LOOM_IMPORTER_CUSTOMER_JOBS: "1",
		});
		await post(box, "u1");
		await post(box, "u2");
		await expectRunning(box, ["u1"], 0);
		expectWaiting(["u2"]);
		await settle(box);
	});

	test("a customer import starts at once while bulk work fills the box", async () => {
		const box = importer({
			LOOM_IMPORTER_MAX_JOBS: "2",
			LOOM_IMPORTER_CUSTOMER_JOBS: "1",
		});
		for (const id of ["f1", "f2", "f3"]) await post(box, id, "bulk");
		await expectRunning(box, ["f1", "f2"], 0);
		await post(box, "c1", "customer");
		await expectRunning(box, ["f1", "f2", "c1"], 1);
		expectWaiting(["f3"]);
		await finish("c1");
		await expectRunning(box, ["f1", "f2"], 0);
		expectWaiting(["f3"]);
		await settle(box);
	});

	test("queued customer imports go before queued bulk imports", async () => {
		const box = importer({
			LOOM_IMPORTER_MAX_JOBS: "1",
			LOOM_IMPORTER_CUSTOMER_JOBS: "1",
		});
		await post(box, "g1", "bulk");
		await post(box, "g2", "bulk");
		await post(box, "k1", "customer");
		await post(box, "k2", "customer");
		await expectRunning(box, ["g1", "k1"], 1);
		expectWaiting(["g2", "k2"]);
		await finish("g1");
		await expectRunning(box, ["k1", "k2"], 2);
		expectWaiting(["g2"]);
		await finish("k1");
		await expectRunning(box, ["k2", "g2"], 1);
		await settle(box);
	});

	test("a full bulk queue does not turn customers away", async () => {
		const box = importer({
			LOOM_IMPORTER_MAX_JOBS: "1",
			LOOM_IMPORTER_CUSTOMER_JOBS: "1",
			LOOM_IMPORTER_MAX_QUEUED: "1",
		});
		expect((await post(box, "q1", "bulk")).status).toBe(200);
		expect((await post(box, "q2", "bulk")).status).toBe(200);
		expect((await post(box, "q3", "bulk")).status).toBe(503);
		expect((await post(box, "q4", "customer")).status).toBe(200);
		expect((await post(box, "q5", "customer")).status).toBe(200);
		expect((await post(box, "q6", "customer")).status).toBe(503);
		await settle(box);
	});
});
