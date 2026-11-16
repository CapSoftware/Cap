import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	sleep: vi.fn(),
	attempt: vi.fn(),
}));

vi.mock("workflow", () => ({ sleep: mocks.sleep }));
vi.mock("@/lib/developer-webhook-delivery", () => ({
	deliverDeveloperWebhookAttempt: mocks.attempt,
}));

const { deliverDeveloperWebhookWorkflow } = await import(
	"@/workflows/deliver-developer-webhook"
);

const job = {
	endpointId: "wh-1",
	eventId: "evt_1",
	eventType: "video.ready",
	body: "{}",
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.sleep.mockResolvedValue(undefined);
	vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("deliver developer webhook workflow", () => {
	it("stops after the first attempt when it is delivered", async () => {
		mocks.attempt.mockResolvedValue("delivered");
		expect(await deliverDeveloperWebhookWorkflow(job)).toEqual({
			outcome: "delivered",
			attempts: 1,
		});
		expect(mocks.attempt).toHaveBeenCalledWith(job);
		expect(mocks.sleep).not.toHaveBeenCalled();
	});

	it("retries a failing endpoint on the schedule and then delivers", async () => {
		mocks.attempt
			.mockResolvedValueOnce("retry")
			.mockResolvedValueOnce("retry")
			.mockResolvedValueOnce("delivered");
		expect(await deliverDeveloperWebhookWorkflow(job)).toEqual({
			outcome: "delivered",
			attempts: 3,
		});
		expect(mocks.sleep.mock.calls.map(([wait]) => wait)).toEqual([
			"60s",
			"300s",
		]);
	});

	it("gives up after eight attempts spread over about a day", async () => {
		mocks.attempt.mockResolvedValue("retry");
		expect(await deliverDeveloperWebhookWorkflow(job)).toEqual({
			outcome: "gave_up",
			attempts: 8,
		});
		expect(mocks.attempt).toHaveBeenCalledTimes(8);
		expect(mocks.sleep.mock.calls.map(([wait]) => wait)).toEqual([
			"60s",
			"300s",
			"1800s",
			"7200s",
			"18000s",
			"28800s",
			"28800s",
		]);
	});

	it("stops retrying once the endpoint is deleted or disabled", async () => {
		mocks.attempt
			.mockResolvedValueOnce("retry")
			.mockResolvedValueOnce("dropped");
		expect(await deliverDeveloperWebhookWorkflow(job)).toEqual({
			outcome: "dropped",
			attempts: 2,
		});
		expect(mocks.sleep).toHaveBeenCalledTimes(1);
	});

	it("keeps an attempt that could not run on the same schedule", async () => {
		mocks.attempt
			.mockRejectedValueOnce(new Error("database is away"))
			.mockResolvedValueOnce("delivered");
		expect(await deliverDeveloperWebhookWorkflow(job)).toEqual({
			outcome: "delivered",
			attempts: 2,
		});
		expect(mocks.sleep.mock.calls.map(([wait]) => wait)).toEqual(["60s"]);
	});
});
