import { describe, expect, it } from "vitest";
import {
	DEFAULT_DASHBOARD_PAGE_SIZE,
	isDashboardPageSize,
	resolveDashboardPageSize,
} from "@/lib/dashboard-page-size";
import {
	addLoomImportCounts,
	emptyLoomImportCounts,
	loomImportFailureReason,
	loomImportState,
} from "@/lib/loom-import-status";
import { chunkIds } from "@/lib/video-archive";
import { WORKFLOW_UPGRADE_ERROR_FRAGMENT } from "@/lib/workflow-recovery";

describe("resolveDashboardPageSize", () => {
	it("uses the saved preference, then falls back to 15", () => {
		expect(resolveDashboardPageSize({})).toBe(DEFAULT_DASHBOARD_PAGE_SIZE);
		expect(resolveDashboardPageSize({ preferences: null })).toBe(15);
		expect(
			resolveDashboardPageSize({
				preferences: { dashboard: { pageSize: 60 } },
			}),
		).toBe(60);
	});

	it("ignores saved values outside the menu", () => {
		expect(
			resolveDashboardPageSize({
				preferences: { dashboard: { pageSize: 5000 } },
			}),
		).toBe(15);
		expect(
			resolveDashboardPageSize({
				preferences: { dashboard: { pageSize: "60" } },
			}),
		).toBe(15);
	});

	it("keeps honouring ?limit= but never past 100", () => {
		expect(resolveDashboardPageSize({ limitParam: "24" })).toBe(24);
		expect(resolveDashboardPageSize({ limitParam: ["30", "60"] })).toBe(30);
		expect(resolveDashboardPageSize({ limitParam: "100000" })).toBe(100);
		expect(
			resolveDashboardPageSize({
				limitParam: "0",
				preferences: { dashboard: { pageSize: 30 } },
			}),
		).toBe(30);
		expect(resolveDashboardPageSize({ limitParam: "abc" })).toBe(15);
	});

	it("only accepts the menu sizes", () => {
		expect([15, 30, 60, 100].every(isDashboardPageSize)).toBe(true);
		expect(isDashboardPageSize(20)).toBe(false);
		expect(isDashboardPageSize("15")).toBe(false);
	});
});

describe("loomImportState", () => {
	it("maps the upload phase a Loom import is in", () => {
		expect(loomImportState(null)).toBe("done");
		expect(loomImportState(undefined)).toBe("done");
		expect(loomImportState("complete")).toBe("done");
		expect(loomImportState("uploading")).toBe("queued");
		expect(loomImportState("processing")).toBe("importing");
		expect(loomImportState("generating_thumbnail")).toBe("importing");
		expect(loomImportState("error")).toBe("failed");
	});

	it("adds counts into totals", () => {
		const totals = emptyLoomImportCounts();
		addLoomImportCounts(totals, { done: 3, failed: 1 });
		addLoomImportCounts(totals, { queued: 2 });
		expect(totals).toEqual({
			queued: 2,
			importing: 0,
			done: 3,
			failed: 1,
			total: 6,
		});
	});
});

describe("loomImportFailureReason", () => {
	it("says Cap will retry only for failures the recovery job restarts", () => {
		expect(
			loomImportFailureReason({
				processingError:
					"import-loom-video: Server is busy; Loom import recovery start failed: x",
				hasRawUpload: true,
			}),
		).toBe("retrying");
		expect(
			loomImportFailureReason({
				processingError: `import-loom-video: ${WORKFLOW_UPGRADE_ERROR_FRAGMENT}`,
				hasRawUpload: true,
			}),
		).toBe("retrying");
		expect(
			loomImportFailureReason({
				processingError: "import-loom-video: SERVER BUSY server_busy",
				hasRawUpload: false,
			}),
		).toBe("stopped");
		expect(
			loomImportFailureReason({
				processingError: "Server is busy",
				hasRawUpload: true,
			}),
		).toBe("stopped");
	});

	it("names a missing Loom source and never echoes raw errors", () => {
		expect(
			loomImportFailureReason({
				processingError: "source-missing: no media",
				hasRawUpload: false,
			}),
		).toBe("source");
		expect(
			loomImportFailureReason({
				processingError: "MEDIA_SERVER_URL is not configured",
				hasRawUpload: true,
			}),
		).toBe("stopped");
		expect(
			loomImportFailureReason({ processingError: null, hasRawUpload: true }),
		).toBe("stopped");
	});
});

describe("chunkIds", () => {
	it("splits large selections into server-sized batches", () => {
		expect(chunkIds([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
		expect(chunkIds([], 2)).toEqual([]);
	});
});
