import {
	afterEach,
	beforeEach,
	describe,
	expect,
	mock,
	spyOn,
	test,
} from "bun:test";
import app from "../../app";
import * as jobManager from "../../lib/job-manager";

const SECRET = "test-secret";
const created: string[] = [];

function addActiveJob(heavyLadder = false) {
	const jobId = jobManager.generateJobId();
	const job = jobManager.createJob(jobId, `video-${created.length}`, "user");
	if (heavyLadder) job.infraHeavyLadder = true;
	created.push(jobId);
	return job;
}

function request(path: string, body: Record<string, unknown>) {
	return new Request(`http://localhost${path}`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"x-media-server-secret": SECRET,
		},
		body: JSON.stringify(body),
	});
}

const ladderBody = (extra: Record<string, unknown> = {}) => ({
	videoId: "video-ladder",
	userId: "app-1",
	videoUrl: "https://example.com/video.mp4",
	maxTier: "2160p",
	uploads: { "master.m3u8": "https://s3.example.com/master" },
	...extra,
});

const processBody = (extra: Record<string, unknown> = {}) => ({
	videoId: "video-process",
	userId: "app-1",
	videoUrl: "https://example.com/video.mp4",
	outputPresignedUrl: "https://s3.example.com/output",
	...extra,
});

let previousSecret: string | undefined;

beforeEach(() => {
	previousSecret = process.env.MEDIA_SERVER_WEBHOOK_SECRET;
	process.env.MEDIA_SERVER_WEBHOOK_SECRET = SECRET;
});

afterEach(() => {
	mock.restore();
	for (const jobId of created.splice(0)) jobManager.deleteJob(jobId);
	if (previousSecret === undefined)
		delete process.env.MEDIA_SERVER_WEBHOOK_SECRET;
	else process.env.MEDIA_SERVER_WEBHOOK_SECRET = previousSecret;
});

describe("capacity for Cap Infra jobs", () => {
	const allows = (
		effectiveMax: number,
		active: number,
		activeHeavyLadders: number,
		heavyLadder: boolean,
	) =>
		jobManager.infraCapacityAllows({
			effectiveMax,
			active,
			activeHeavyLadders,
			heavyLadder,
			reservedSlots: 1,
			maxHeavyLadders: 1,
		});

	test("leaves one slot that Infra jobs cannot take", () => {
		expect(allows(4, 0, 0, false)).toBe(true);
		expect(allows(4, 2, 0, false)).toBe(true);
		expect(allows(4, 3, 0, false)).toBe(false);
		expect(allows(4, 4, 0, false)).toBe(false);
	});

	test("runs one heavy Infra ladder at a time", () => {
		expect(allows(4, 0, 0, true)).toBe(true);
		expect(allows(4, 1, 1, true)).toBe(false);
		expect(allows(4, 1, 1, false)).toBe(true);
	});

	test("a throttled worker with one slot keeps today's behaviour", () => {
		expect(allows(1, 0, 0, true)).toBe(true);
		expect(allows(1, 1, 0, false)).toBe(false);
		expect(allows(0, 0, 0, false)).toBe(false);
	});

	test("a larger reserve shrinks with the worker but never to nothing", () => {
		const allowsWithReserve = (effectiveMax: number, active: number) =>
			jobManager.infraCapacityAllows({
				effectiveMax,
				active,
				activeHeavyLadders: 0,
				heavyLadder: false,
				reservedSlots: 2,
				maxHeavyLadders: 1,
			});
		expect(allowsWithReserve(4, 1)).toBe(true);
		expect(allowsWithReserve(4, 2)).toBe(false);
		expect(allowsWithReserve(2, 0)).toBe(true);
		expect(allowsWithReserve(2, 1)).toBe(false);
		expect(allowsWithReserve(1, 0)).toBe(true);
	});

	test("a slice keeps half of the worker's slots free, and never less than the reserve", () => {
		const sliceAllows = (
			effectiveMax: number,
			active: number,
			reservedSlots = 1,
		) =>
			jobManager.infraCapacityAllows({
				effectiveMax,
				active,
				activeHeavyLadders: 0,
				heavyLadder: false,
				reservedSlots: jobManager.infraSliceReservedSlots(
					effectiveMax,
					reservedSlots,
				),
				maxHeavyLadders: 1,
			});
		expect(jobManager.infraSliceReservedSlots(4, 1)).toBe(2);
		expect(jobManager.infraSliceReservedSlots(5, 1)).toBe(3);
		expect(jobManager.infraSliceReservedSlots(4, 3)).toBe(3);
		expect(sliceAllows(4, 1)).toBe(true);
		expect(sliceAllows(4, 2)).toBe(false);
		expect(sliceAllows(5, 2)).toBe(false);
		expect(sliceAllows(6, 2)).toBe(true);
		expect(sliceAllows(6, 3)).toBe(false);
		expect(sliceAllows(2, 0)).toBe(true);
		expect(sliceAllows(2, 1)).toBe(false);
		expect(sliceAllows(1, 0)).toBe(true);
		expect(sliceAllows(1, 1)).toBe(false);
		expect(sliceAllows(4, 0, 3)).toBe(true);
		expect(sliceAllows(4, 1, 3)).toBe(false);
	});

	test("a heavy slice still waits for the running heavy ladder", () => {
		expect(
			jobManager.infraCapacityAllows({
				effectiveMax: 8,
				active: 1,
				activeHeavyLadders: 1,
				heavyLadder: true,
				reservedSlots: jobManager.infraSliceReservedSlots(8, 1),
				maxHeavyLadders: 1,
			}),
		).toBe(false);
	});

	test("counts only heavy ladders that are still running", () => {
		const before = jobManager.getActiveInfraHeavyLadderCount();
		const job = addActiveJob(true);
		addActiveJob(false);
		expect(jobManager.getActiveInfraHeavyLadderCount()).toBe(before + 1);
		jobManager.updateJob(job.jobId, { phase: "complete", progress: 100 });
		expect(jobManager.getActiveInfraHeavyLadderCount()).toBe(before);
	});
});

describe("routes", () => {
	test("an Infra ladder over its limit gets the busy answer", async () => {
		spyOn(jobManager, "canAcceptNewVideoProcess").mockReturnValue(true);
		const infra = spyOn(
			jobManager,
			"canAcceptNewInfraVideoProcess",
		).mockReturnValue(false);
		const response = await app.fetch(
			request("/video/ladder", ladderBody({ infra: true })),
		);
		expect(response.status).toBe(503);
		expect((await response.json()).code).toBe("SERVER_BUSY");
		expect(response.headers.get("Retry-After")).not.toBeNull();
		expect(infra).toHaveBeenCalledWith(true, false);
	});

	test("a 1080p Infra ladder is not counted as heavy", async () => {
		spyOn(jobManager, "canAcceptNewVideoProcess").mockReturnValue(true);
		const infra = spyOn(
			jobManager,
			"canAcceptNewInfraVideoProcess",
		).mockReturnValue(false);
		await app.fetch(
			request("/video/ladder", ladderBody({ infra: true, maxTier: "1080p" })),
		);
		expect(infra).toHaveBeenCalledWith(false, false);
	});

	test("an Infra ladder slice is held to the slice reserve", async () => {
		spyOn(jobManager, "canAcceptNewVideoProcess").mockReturnValue(true);
		const infra = spyOn(
			jobManager,
			"canAcceptNewInfraVideoProcess",
		).mockReturnValue(false);
		const response = await app.fetch(
			request(
				"/video/ladder",
				ladderBody({
					infra: true,
					range: { startSeconds: 20, durationSeconds: 96 },
				}),
			),
		);
		expect(response.status).toBe(503);
		expect(response.headers.get("Retry-After")).not.toBeNull();
		expect(infra).toHaveBeenCalledWith(true, true);
	});

	test("an Infra MP4 over its limit gets the busy answer", async () => {
		spyOn(jobManager, "canAcceptNewVideoProcess").mockReturnValue(true);
		const infra = spyOn(
			jobManager,
			"canAcceptNewInfraVideoProcess",
		).mockReturnValue(false);
		const response = await app.fetch(
			request("/video/process", processBody({ infra: true })),
		);
		expect(response.status).toBe(503);
		expect(infra).toHaveBeenCalledWith(false);
	});

	test("Cap's own jobs never consult the Infra limits", async () => {
		spyOn(jobManager, "canAcceptNewVideoProcess").mockReturnValue(false);
		const infra = spyOn(
			jobManager,
			"canAcceptNewInfraVideoProcess",
		).mockReturnValue(false);
		const ladder = await app.fetch(request("/video/ladder", ladderBody()));
		const process = await app.fetch(request("/video/process", processBody()));
		expect(ladder.status).toBe(503);
		expect(process.status).toBe(503);
		expect(infra).not.toHaveBeenCalled();
	});
});
