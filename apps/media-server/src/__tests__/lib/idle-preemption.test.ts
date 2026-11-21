import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getContainerCpuUsageMicros } from "../../lib/container-cpu";
import {
	idleProcessCpuMicros,
	parseProcStatCpuMicros,
	trackIdleProcess,
} from "../../lib/idle-processes";
import {
	canAcceptNewInfraVideoProcess,
	canAcceptNewVideoProcess,
	cpuPressureOverWindow,
	createJob,
	deleteJob,
	generateJobId,
	getActiveHeavyLadderCount,
	getActiveInfraHeavyLadderCount,
	getActiveVideoProcessCount,
	getJob,
	getJobProgress,
	IDLE_PREEMPTED,
	idleYieldReason,
	infraCapacityAllows,
	infraSliceReservedSlots,
	type Job,
	loadPressureWithoutIdle,
	preemptIdleJobs,
} from "../../lib/job-manager";
import { isDraining, setDraining } from "../../lib/lifecycle";
import { tryAcquireDirectVideoProcessSlot } from "../../lib/video-capacity";

const created: string[] = [];

function addJob(options: { idle?: boolean } = {}): Job {
	const jobId = generateJobId();
	created.push(jobId);
	return createJob(jobId, "video", "user", undefined, undefined, options);
}

function addIdleJob(): { job: Job; abort: AbortController } {
	const job = addJob({ idle: true });
	const abort = new AbortController();
	job.abortController = abort;
	job.phase = "processing";
	return { job, abort };
}

function expectPreempted(job: Job, abort: AbortController) {
	expect(abort.signal.aborted).toBe(true);
	expect(job.phase).toBe("error");
	const progress = getJobProgress(job);
	expect(progress.errorCode).toBe("idle-preempted");
	expect(progress.retryable).toBe(true);
	expect(progress.error).toBeString();
}

afterEach(() => {
	for (const jobId of created.splice(0)) deleteJob(jobId);
	if (isDraining()) setDraining(false);
});

describe("idle jobs and other admissions", () => {
	test("an idle job does not count towards any other job's slots", () => {
		addJob();
		addJob();
		const before = getActiveVideoProcessCount();
		addIdleJob();
		expect(getActiveVideoProcessCount()).toBe(before);
	});

	test("with an idle job present every admission answers as it would without it", () => {
		const without = {
			interactive: canAcceptNewVideoProcess(),
			recovery: canAcceptNewVideoProcess("recovery"),
			infra: canAcceptNewInfraVideoProcess(false),
			infraHeavy: canAcceptNewInfraVideoProcess(true),
			infraSlice: canAcceptNewInfraVideoProcess(false, true),
		};
		const { job } = addIdleJob();
		job.heavyLadder = true;
		expect({
			interactive: canAcceptNewVideoProcess(),
			recovery: canAcceptNewVideoProcess("recovery"),
			infra: canAcceptNewInfraVideoProcess(false),
			infraHeavy: canAcceptNewInfraVideoProcess(true),
			infraSlice: canAcceptNewInfraVideoProcess(false, true),
		}).toEqual(without);
	});

	test("an Infra job on a worker of four with two running and an idle job is admitted", () => {
		const base = getActiveVideoProcessCount();
		addJob();
		addJob();
		addIdleJob();
		const active = getActiveVideoProcessCount() - base;
		expect(active).toBe(2);
		expect(
			infraCapacityAllows({
				effectiveMax: 4,
				active,
				activeHeavyLadders: 0,
				heavyLadder: false,
			}),
		).toBe(true);
	});

	test("an Infra slice with one running and an idle job is admitted", () => {
		const base = getActiveVideoProcessCount();
		addJob();
		addIdleJob();
		const active = getActiveVideoProcessCount() - base;
		expect(active).toBe(1);
		expect(
			infraCapacityAllows({
				effectiveMax: 4,
				active,
				activeHeavyLadders: 0,
				heavyLadder: false,
				reservedSlots: infraSliceReservedSlots(4),
				slice: true,
				activeInfraMp4s: 0,
			}),
		).toBe(true);
	});

	test("an idle heavy ladder is not an Infra heavy ladder but still holds other idle jobs back", () => {
		const infraHeavy = getActiveInfraHeavyLadderCount();
		const heavy = getActiveHeavyLadderCount();
		const { job } = addIdleJob();
		job.heavyLadder = true;
		expect(getActiveInfraHeavyLadderCount()).toBe(infraHeavy);
		expect(getActiveHeavyLadderCount()).toBe(heavy + 1);
	});
});

describe("preemption", () => {
	test("any other job admitted stops the idle job", () => {
		const { job, abort } = addIdleJob();
		addJob();
		expectPreempted(job, abort);
	});

	test("a direct conversion stops the idle job", () => {
		const { job, abort } = addIdleJob();
		const slot = tryAcquireDirectVideoProcessSlot(() => true);
		try {
			expect(slot).not.toBeNull();
			expectPreempted(job, abort);
		} finally {
			slot?.release();
		}
	});

	test("draining stops the idle job", () => {
		const { job, abort } = addIdleJob();
		setDraining(true);
		expectPreempted(job, abort);
	});

	test("another idle job does not stop it, and a finished idle job is left alone", () => {
		const first = addIdleJob();
		const second = addIdleJob();
		expect(first.abort.signal.aborted).toBe(false);
		second.job.phase = "complete";
		expect(preemptIdleJobs("test")).toBe(1);
		expect(second.job.errorCode).toBeUndefined();
		expect(getJob(first.job.jobId)?.errorCode).toBe(IDLE_PREEMPTED);
	});

	test("a job without the idle flag is never preempted", () => {
		const job = addJob();
		job.phase = "processing";
		expect(preemptIdleJobs("test")).toBe(0);
		expect(job.phase).toBe("processing");
	});
});

describe("idleYieldReason", () => {
	test("yields at 0.7 CPU or 0.75 memory", () => {
		expect(
			idleYieldReason({ totalCpuPressure: 0.69, memoryPressure: 0.74 }),
		).toBeNull();
		expect(
			idleYieldReason({ totalCpuPressure: 0.7, memoryPressure: 0 }),
		).toContain("CPU");
		expect(
			idleYieldReason({ totalCpuPressure: 0, memoryPressure: 0.75 }),
		).toContain("memory");
	});
});

describe("pressure without idle CPU", () => {
	const dir = mkdtempSync(join(tmpdir(), "cap-idle-cpu-"));
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	function cgroupUsage(usec: number): number {
		const cpuStatPath = join(dir, "cpu.stat");
		writeFileSync(
			cpuStatPath,
			`usage_usec ${usec}\nuser_usec 0\nsystem_usec 0\n`,
		);
		return getContainerCpuUsageMicros({ cpuStatPath });
	}

	function procStat(utimeTicks: number, stimeTicks: number): string {
		const fields = Array.from({ length: 40 }, () => "0");
		fields[11] = String(utimeTicks);
		fields[12] = String(stimeTicks);
		return `4242 (ffmpeg (x264)) S ${fields.slice(1).join(" ")}`;
	}

	test("reads utime and stime from a /proc stat line", () => {
		expect(parseProcStatCpuMicros(procStat(150, 50))).toBe(2_000_000);
		expect(parseProcStatCpuMicros("garbage")).toBeNull();
	});

	test("takes the idle process's CPU over the same window off the cgroup reading", () => {
		const usedMicros = cgroupUsage(12_800_000) - cgroupUsage(10_000_000);
		const idleMicros =
			(parseProcStatCpuMicros(procStat(300, 100)) ?? 0) -
			(parseProcStatCpuMicros(procStat(120, 80)) ?? 0);
		const pressure = cpuPressureOverWindow({
			elapsedMs: 1_000,
			usedMicros,
			idleMicros,
			cpuCapacity: 4,
		});
		expect(pressure.total).toBeCloseTo(0.7, 9);
		expect(pressure.withoutIdle).toBeCloseTo(0.2, 9);
	});

	test("never reports less than nothing", () => {
		expect(
			cpuPressureOverWindow({
				elapsedMs: 1_000,
				usedMicros: 1_000_000,
				idleMicros: 3_000_000,
				cpuCapacity: 4,
			}).withoutIdle,
		).toBe(0);
	});

	test("takes the idle cores off the load average without a cgroup", () => {
		const pressure = loadPressureWithoutIdle(6, 2, 8);
		expect(pressure.total).toBe(0.75);
		expect(pressure.withoutIdle).toBe(0.5);
		expect(loadPressureWithoutIdle(1, 3, 8).withoutIdle).toBe(0);
	});

	test("counts the CPU an idle process used once it has exited", async () => {
		const before = idleProcessCpuMicros();
		const proc = Bun.spawn(
			[
				"ffmpeg",
				"-v",
				"error",
				"-f",
				"lavfi",
				"-i",
				"testsrc2=size=640x360:rate=30:duration=2",
				"-f",
				"null",
				"-",
			],
			{ stdout: "ignore", stderr: "ignore" },
		);
		trackIdleProcess(proc);
		await proc.exited;
		expect(idleProcessCpuMicros()).toBeGreaterThan(before);
	});
});
