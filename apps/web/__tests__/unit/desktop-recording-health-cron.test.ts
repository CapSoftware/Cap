import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { recover, getHealth } = vi.hoisted(() => ({
	recover: vi.fn(),
	getHealth: vi.fn(),
}));

vi.mock("@/lib/desktop-segments-recovery", () => ({
	recoverStaleDesktopSegments: recover,
}));
vi.mock("@/lib/desktop-recording-health", () => ({
	getDesktopRecordingHealth: getHealth,
}));

import { GET } from "@/app/api/cron/finalize-stale-desktop-segments/route";

const healthy = {
	status: "healthy",
	checkedAt: "2026-09-04T14:00:00.000Z",
	scope: "unresolved",
	stalledWorkers: 0,
	stalledCommits: 0,
	retryLoops: 0,
	blockedCommittedSources: 0,
	changedSources: 0,
};

function request(token = "test-cron-secret") {
	return new Request(
		"http://localhost/api/cron/finalize-stale-desktop-segments",
		{
			headers: { authorization: `Bearer ${token}` },
		},
	);
}

beforeEach(() => {
	vi.stubEnv("CRON_SECRET", "test-cron-secret");
	recover.mockResolvedValue({ checked: 1, statuses: {}, results: [] });
	getHealth.mockResolvedValue(healthy);
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => vi.unstubAllEnvs());

describe("recording recovery health reporting", () => {
	it("does not inspect or recover recordings without cron authentication", async () => {
		expect((await GET(request("wrong"))).status).toBe(401);
		expect(recover).not.toHaveBeenCalled();
		expect(getHealth).not.toHaveBeenCalled();
	});

	it("does not classify incomplete uploads as processing incidents", async () => {
		recover.mockResolvedValue({
			checked: 2,
			statuses: { "source-incomplete": 2 },
			results: [],
		});
		const response = await GET(request());
		expect(response.status).toBe(200);
		expect((await response.json()).health).toEqual(healthy);
		expect(console.error).not.toHaveBeenCalled();
	});

	it("runs recovery before surfacing persistent retry loops as a failed cron", async () => {
		getHealth.mockResolvedValue({
			...healthy,
			status: "degraded",
			retryLoops: 2,
		});
		const response = await GET(request());
		expect(recover).toHaveBeenCalledOnce();
		expect(recover.mock.invocationCallOrder[0]).toBeLessThan(
			getHealth.mock.invocationCallOrder[0] ?? 0,
		);
		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({
			success: false,
			health: { retryLoops: 2 },
		});
		expect(console.error).toHaveBeenCalledWith(
			"[recording-health] Processing needs attention",
			expect.objectContaining({ retryLoops: 2, recoveryFailures: 0 }),
		);
	});

	it("surfaces failed recovery even when no aged jobs remain", async () => {
		recover.mockResolvedValue({
			checked: 1,
			statuses: { failed: 1 },
			results: [],
		});
		expect((await GET(request())).status).toBe(503);
	});

	it("does not report healthy when the health query fails", async () => {
		getHealth.mockRejectedValue(new Error("Database unavailable"));
		await expect(GET(request())).rejects.toThrow("Database unavailable");
		expect(recover).toHaveBeenCalledOnce();
	});
});
