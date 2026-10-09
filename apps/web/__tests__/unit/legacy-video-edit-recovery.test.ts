import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const list = vi.hoisted(() => vi.fn());
vi.mock("workflow/runtime", () => ({
	getWorld: () => ({ runs: { list } }),
}));

import { assertLegacyEditsQuiescent } from "@/lib/legacy-video-edit-recovery";

beforeEach(() => {
	list.mockReset().mockResolvedValue({ data: [] });
	vi.stubEnv("CAP_LEGACY_EDIT_RECOVERY", "enabled");
});
afterEach(() => vi.unstubAllEnvs());

describe("legacy edit recovery rollout", () => {
	it("refuses recovery until older deployments and workers have been drained", async () => {
		vi.stubEnv("CAP_LEGACY_EDIT_RECOVERY", "");
		await expect(assertLegacyEditsQuiescent("edit-workflow")).rejects.toThrow(
			"support recovery",
		);
		expect(list).not.toHaveBeenCalled();
	});
	it.each(["pending", "running"])(
		"refuses recovery while an edit is %s",
		async (status) => {
			list.mockImplementation(async (query: { status: string }) => ({
				data: query.status === status ? [{ runId: "active" }] : [],
			}));
			await expect(assertLegacyEditsQuiescent("edit-workflow")).rejects.toThrow(
				"still finishing",
			);
		},
	);
	it("fails closed when workflow state is unavailable", async () => {
		list.mockRejectedValue(new Error("Workflow service unavailable"));
		await expect(assertLegacyEditsQuiescent("edit-workflow")).rejects.toThrow(
			"Workflow service unavailable",
		);
	});
	it("allows recovery after the explicit drain and runtime checks", async () => {
		await expect(
			assertLegacyEditsQuiescent("edit-workflow"),
		).resolves.toBeUndefined();
		expect(list).toHaveBeenCalledWith(
			expect.objectContaining({
				workflowName: "edit-workflow",
				status: "pending",
				resolveData: "none",
			}),
		);
		expect(list).toHaveBeenCalledWith(
			expect.objectContaining({
				workflowName: "edit-workflow",
				status: "running",
			}),
		);
	});
});
