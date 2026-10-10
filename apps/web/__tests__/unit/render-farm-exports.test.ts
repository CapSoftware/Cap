import { describe, expect, it } from "vitest";
import {
	parseRenderFarmReference,
	renderFarmKeys,
	renderFarmReference,
} from "@/lib/render-farm";
import {
	attachmentDisposition,
	awaitingPendingRenderJob,
	pickRenderExport,
	RENDER_EXPORT_TTL_MS,
	renderExportFileName,
	renderExportView,
	upsertRenderFarmExport,
} from "@/lib/render-farm-status";

const item = {
	exportId: "export-1",
	jobId: "job-1",
	status: "ready" as const,
	startedAt: "2026-09-26T00:00:00.000Z",
	completedAt: "2026-09-26T00:05:00.000Z",
	outputKey: "owner/video/.recording/render/export-1/export.mp4",
	fileName: "Demo.mp4",
	resolution: [1920, 1080] as [number, number],
	fps: 30,
	bytes: 1234,
};

describe("render farm references", () => {
	it("keeps saves on the bare video id and tags other jobs", () => {
		expect(renderFarmReference("save", "abc123")).toBe("abc123");
		expect(renderFarmReference("export", "abc123")).toBe("export:abc123");
		expect(parseRenderFarmReference("abc123")).toEqual({
			kind: "save",
			videoId: "abc123",
		});
		expect(parseRenderFarmReference("recording:abc123")).toEqual({
			kind: "recording",
			videoId: "abc123",
		});
		expect(parseRenderFarmReference("export:abc123")).toEqual({
			kind: "export",
			videoId: "abc123",
		});
	});

	it("rejects unknown kinds and malformed ids", () => {
		expect(parseRenderFarmReference("thumbnail:abc123")).toBeNull();
		expect(parseRenderFarmReference("export:")).toBeNull();
		expect(parseRenderFarmReference("export:../other")).toBeNull();
		expect(parseRenderFarmReference("")).toBeNull();
	});

	it("writes exports beside, not over, the share render", () => {
		expect(renderFarmKeys("owner", "video", "e1").outputKey).toBe(
			"owner/video/.recording/render/e1/result.mp4",
		);
		expect(renderFarmKeys("owner", "video", "e1", "export").outputKey).toBe(
			"owner/video/.recording/render/e1/export.mp4",
		);
	});
});

describe("background export status", () => {
	const completed = Date.parse(item.completedAt);

	it("maps stored exports to what the download page shows", () => {
		expect(renderExportView(item, completed + 1000)).toMatchObject({
			state: "ready",
			bytes: 1234,
			error: null,
		});
		expect(
			renderExportView(
				{ ...item, status: "rendering", completedAt: undefined },
				completed,
			).state,
		).toBe("rendering");
		expect(
			renderExportView({ ...item, status: "error" }, completed),
		).toMatchObject({ state: "error", error: "Export failed" });
	});

	it("expires ready exports after the retention window", () => {
		expect(
			renderExportView(item, completed + RENDER_EXPORT_TTL_MS + 1).state,
		).toBe("expired");
		expect(
			renderExportView({ ...item, completedAt: undefined }, completed).state,
		).toBe("expired");
	});

	it("keeps the newest ten exports and replaces by id", () => {
		const many = Array.from({ length: 12 }, (_, index) => ({
			...item,
			exportId: `export-${index}`,
		}));
		const next = upsertRenderFarmExport(many, {
			...item,
			exportId: "export-5",
			status: "error",
		});
		expect(next).toHaveLength(10);
		expect(next[0]).toMatchObject({ exportId: "export-5", status: "error" });
		expect(
			next.filter((candidate) => candidate.exportId === "export-5"),
		).toHaveLength(1);
	});

	it("picks the named export, or the newest", () => {
		const views = [
			renderExportView({ ...item, exportId: "b" }, completed),
			renderExportView({ ...item, exportId: "a" }, completed),
		];
		expect(pickRenderExport(views, "a")?.exportId).toBe("a");
		expect(pickRenderExport(views, null)?.exportId).toBe("b");
		expect(pickRenderExport(views, "missing")).toBeNull();
		expect(pickRenderExport([], null)).toBeNull();
	});

	it("waits for a recording render's job only for a while", () => {
		const startedAt = "2026-09-26T00:00:00.000Z";
		expect(
			awaitingPendingRenderJob({ startedAt }, Date.parse(startedAt) + 60_000),
		).toBe(true);
		expect(
			awaitingPendingRenderJob(
				{ startedAt },
				Date.parse(startedAt) + 31 * 60_000,
			),
		).toBe(false);
	});
});

describe("export downloads", () => {
	it("names the file after the video, safely", () => {
		expect(renderExportFileName("Q3 Roadmap: Review")).toBe(
			"Q3 Roadmap Review.mp4",
		);
		expect(renderExportFileName("Café déjà vu")).toBe("Cafe deja vu.mp4");
		expect(renderExportFileName("../../etc/passwd")).toBe("etc passwd.mp4");
		expect(renderExportFileName("Screen Recording.MP4")).toBe(
			"Screen Recording.mp4",
		);
		expect(renderExportFileName("")).toBe("Cap Export.mp4");
		expect(renderExportFileName(null)).toBe("Cap Export.mp4");
		expect(renderExportFileName("录屏")).toBe("Cap Export.mp4");
		expect(renderExportFileName("x".repeat(300))).toBe(
			`${"x".repeat(120)}.mp4`,
		);
	});

	it("builds an attachment disposition with a UTF-8 fallback", () => {
		expect(attachmentDisposition("Demo.mp4")).toBe(
			`attachment; filename="Demo.mp4"; filename*=UTF-8''Demo.mp4`,
		);
		expect(attachmentDisposition('a"b\\c é.mp4')).toBe(
			`attachment; filename="a_b_c _.mp4"; filename*=UTF-8''a%22b%5Cc%20%C3%A9.mp4`,
		);
	});
});
