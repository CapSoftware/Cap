import { afterAll, beforeAll, describe, expect, test } from "bun:test";

const SECRET = "test-secret";
const created: string[] = [];
let app: typeof import("../../app").default;
let jobManager: typeof import("../../lib/job-manager");
let previousMax: string | undefined;
let previousSecret: string | undefined;

beforeAll(async () => {
	previousMax = process.env.MEDIA_SERVER_MAX_CONCURRENT_VIDEO_PROCESSES;
	previousSecret = process.env.MEDIA_SERVER_WEBHOOK_SECRET;
	process.env.MEDIA_SERVER_MAX_CONCURRENT_VIDEO_PROCESSES = "4";
	process.env.MEDIA_SERVER_WEBHOOK_SECRET = SECRET;
	app = (await import("../../app")).default;
	jobManager = await import("../../lib/job-manager");
});

afterAll(() => {
	for (const jobId of created.splice(0)) jobManager.deleteJob(jobId);
	if (previousMax === undefined)
		delete process.env.MEDIA_SERVER_MAX_CONCURRENT_VIDEO_PROCESSES;
	else process.env.MEDIA_SERVER_MAX_CONCURRENT_VIDEO_PROCESSES = previousMax;
	if (previousSecret === undefined)
		delete process.env.MEDIA_SERVER_WEBHOOK_SECRET;
	else process.env.MEDIA_SERVER_WEBHOOK_SECRET = previousSecret;
});

function addJob(setup: (job: import("../../lib/job-manager").Job) => void) {
	const jobId = jobManager.generateJobId();
	created.push(jobId);
	const job = jobManager.createJob(jobId, "video", "user");
	job.phase = "processing";
	setup(job);
	return job;
}

function addIdleJob() {
	const jobId = jobManager.generateJobId();
	created.push(jobId);
	const job = jobManager.createJob(
		jobId,
		"video",
		"user",
		undefined,
		undefined,
		{ idle: true },
	);
	job.phase = "processing";
	job.heavyLadder = true;
	return job;
}

function clearJobs() {
	for (const jobId of created.splice(0)) jobManager.deleteJob(jobId);
}

async function answers() {
	const response = await app.request("/video/status", {
		headers: { "x-media-server-secret": SECRET },
	});
	const status = (await response.json()) as {
		activeVideoProcesses: number;
		effectiveMaxVideoProcesses: number;
	};
	return {
		activeVideoProcesses: status.activeVideoProcesses,
		effectiveMax: status.effectiveMaxVideoProcesses,
		interactive: jobManager.canAcceptNewVideoProcess(),
		recovery: jobManager.canAcceptNewVideoProcess("recovery"),
		bulk: !(
			status.effectiveMaxVideoProcesses > 1 &&
			status.activeVideoProcesses >= status.effectiveMaxVideoProcesses - 1
		),
		infra: jobManager.canAcceptNewInfraVideoProcess(false),
		infraHeavy: jobManager.canAcceptNewInfraVideoProcess(true),
		infraSlice: jobManager.canAcceptNewInfraVideoProcess(false, true),
	};
}

describe("every admission with and without an idle job", () => {
	const cases = [0, 1, 2, 3, 4].flatMap((active) =>
		[false, true].flatMap((infraMp4) =>
			[false, true].map((infraHeavyLadder) => ({
				active,
				infraMp4,
				infraHeavyLadder,
			})),
		),
	);

	for (const { active, infraMp4, infraHeavyLadder } of cases) {
		test(`${active} running, Infra MP4 ${infraMp4}, Infra heavy ladder ${infraHeavyLadder}`, async () => {
			clearJobs();
			const jobs = Array.from({ length: active }, () => addJob(() => {}));
			if (infraMp4 && jobs[0]) jobs[0].infraMp4 = true;
			if (infraHeavyLadder && jobs.at(-1)) {
				const heavy = jobs.at(-1);
				if (heavy) heavy.infraHeavyLadder = true;
			}
			const without = await answers();
			expect(without.effectiveMax).toBe(4);
			const idle = addIdleJob();
			const withIdle = await answers();
			expect(withIdle).toEqual(without);
			expect(idle.phase).toBe("processing");
		});
	}
});

describe("CPU an idle process uses", () => {
	test("does not count towards the 0.8 throttle other jobs see", () => {
		const window = { elapsedMs: 1_000, cpuCapacity: 4 };
		const quietWorker = jobManager.cpuPressureOverWindow({
			...window,
			usedMicros: 2_800_000,
			idleMicros: 0,
		});
		const withIdle = jobManager.cpuPressureOverWindow({
			...window,
			usedMicros: 2_800_000 + 1_200_000,
			idleMicros: 1_200_000,
		});
		expect(withIdle.total).toBeGreaterThan(0.8);
		expect(quietWorker.total).toBeLessThan(0.8);
		expect(withIdle.withoutIdle).toBeCloseTo(quietWorker.total, 9);
		expect(withIdle.withoutIdle).toBeCloseTo(quietWorker.withoutIdle, 9);
	});
});
