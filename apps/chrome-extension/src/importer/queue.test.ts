import { describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "../shared/api";
import type { ImportResponse } from "./api";
import { buildInventory, detectColumns, parseInventory } from "./inventory";
import { type ImportOutcome, runImportQueue } from "./queue";

const table = parseInventory(
	[
		"loom_video_url,user_email",
		"https://www.loom.com/share/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa,owner@example.test",
		"https://www.loom.com/share/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb,owner@example.test",
		"https://www.loom.com/share/cccccccccccccccccccccccccccccccc,owner@example.test",
	].join("\n"),
	"inventory.csv",
);
const rows = buildInventory(table, detectColumns(table.headers), {
	ownerMode: "column",
	ownerEmail: "",
	spaceMode: "none",
	spaceName: "",
});

const queueOptions = () => {
	const updates: ImportOutcome[] = [];
	return {
		rows,
		updates,
		submit: vi.fn(
			async (): Promise<ImportResponse> => ({
				success: true,
				videoId: "cap-video",
			}),
		),
		onUpdate: vi.fn(async (outcome: ImportOutcome) => {
			updates.push(outcome);
		}),
		shouldStop: () => false,
		delay: vi.fn(async () => undefined),
	};
};

describe("Loom import queue", () => {
	it("awaits durable sending state before each sequential request and never calls started complete", async () => {
		const options = queueOptions();
		const events: string[] = [];
		options.onUpdate.mockImplementation(async (outcome) => {
			events.push(`${outcome.sourceRecord}:${outcome.state}`);
			await Promise.resolve();
		});
		options.submit.mockImplementation(async () => {
			events.push("submit");
			return { success: true, videoId: "cap-video" };
		});
		await runImportQueue(options);
		expect(events).toEqual([
			"1:sending",
			"submit",
			"1:started",
			"2:sending",
			"submit",
			"2:started",
			"3:sending",
			"submit",
			"3:started",
		]);
		expect(options.delay).toHaveBeenCalledTimes(2);
	});

	it("keeps existing, rejected and started results distinct", async () => {
		const options = queueOptions();
		options.submit
			.mockResolvedValueOnce({
				success: true,
				videoId: "existing-video",
				existing: true,
				error: "Ownership unchanged.",
			})
			.mockResolvedValueOnce({
				success: false,
				error: "The video is unavailable.",
			})
			.mockResolvedValueOnce({ success: true, videoId: "new-video" });
		await runImportQueue(options);
		expect(
			options.updates.filter((value) => value.state !== "sending"),
		).toEqual([
			{
				sourceRecord: 1,
				state: "existing",
				videoId: "existing-video",
				message: "Ownership unchanged.",
			},
			{
				sourceRecord: 2,
				state: "failed",
				videoId: undefined,
				message: "The video is unavailable.",
			},
			{
				sourceRecord: 3,
				state: "started",
				videoId: "new-video",
				message: undefined,
			},
		]);
	});

	it("waits for an active request before pausing, without canceling accepted work", async () => {
		const options = queueOptions();
		let stop = false;
		let release: ((value: ImportResponse) => void) | undefined;
		options.submit.mockImplementation(
			() =>
				new Promise<ImportResponse>((resolve) => {
					release = resolve;
				}),
		);
		const done = runImportQueue({ ...options, shouldStop: () => stop });
		await vi.waitFor(() => expect(release).toBeTypeOf("function"));
		stop = true;
		release?.({ success: true, videoId: "accepted-video" });
		await done;
		expect(options.submit).toHaveBeenCalledTimes(1);
		expect(options.updates.at(-1)?.state).toBe("started");
		expect(options.delay).not.toHaveBeenCalled();
	});

	it.each([
		new TypeError("Network disconnected"),
		new ApiRequestError(500, "Unavailable"),
		new ApiRequestError(408, "Request timed out"),
	])("stops on an unknown outcome without retrying it: %s", async (error) => {
		const options = queueOptions();
		options.submit.mockRejectedValue(error);
		await runImportQueue(options);
		expect(options.submit).toHaveBeenCalledTimes(1);
		expect(options.updates.at(-1)).toMatchObject({
			state: "uncertain",
			message: error.message,
		});
		expect(options.delay).not.toHaveBeenCalled();
	});

	it.each([400, 401, 403, 404, 413, 422, 429])(
		"preserves a definite HTTP %s rejection for explicit retry and pauses the queue",
		async (status) => {
			const options = queueOptions();
			options.submit.mockRejectedValue(new ApiRequestError(status, "Rejected"));
			await runImportQueue(options);
			expect(options.submit).toHaveBeenCalledTimes(1);
			expect(options.updates.at(-1)?.state).toBe("failed");
		},
	);

	it.each<ImportResponse>([
		{ success: false, uncertain: true, error: "Partially started." },
		{ success: true },
	])(
		"locks server-reported or malformed uncertain success: %j",
		async (response) => {
			const options = queueOptions();
			options.submit.mockResolvedValue(response);
			await runImportQueue(options);
			expect(options.submit).toHaveBeenCalledTimes(1);
			expect(options.updates.at(-1)?.state).toBe("uncertain");
		},
	);

	it("does not submit without durable local progress", async () => {
		const options = queueOptions();
		options.onUpdate.mockRejectedValue(new Error("Storage full"));
		await expect(runImportQueue(options)).rejects.toThrow("Storage full");
		expect(options.submit).not.toHaveBeenCalled();
	});

	it("stops after a confirmed response cannot be saved, retaining sending as the recovery marker", async () => {
		const options = queueOptions();
		options.onUpdate.mockImplementation(async (outcome) => {
			if (outcome.state !== "sending") throw new Error("Storage full");
			options.updates.push(outcome);
		});
		await expect(runImportQueue(options)).rejects.toThrow("Storage full");
		expect(options.submit).toHaveBeenCalledTimes(1);
		expect(options.updates).toEqual([{ sourceRecord: 1, state: "sending" }]);
	});

	it("refuses invalid source rows before any request", async () => {
		const options = queueOptions();
		await expect(
			runImportQueue({
				...options,
				rows: [{ ...rows[0], issue: "missing-link" }],
			}),
		).rejects.toThrow("Only valid rows");
		expect(options.submit).not.toHaveBeenCalled();
	});

	it("honors an already requested pause", async () => {
		const options = queueOptions();
		await runImportQueue({ ...options, shouldStop: () => true });
		expect(options.onUpdate).not.toHaveBeenCalled();
		expect(options.submit).not.toHaveBeenCalled();
	});
});
