import { describe, expect, it, vi } from "vitest";
import { mergeLoomImportItems } from "@/app/(org)/dashboard/import/loom/[jobId]/use-loom-import-job";
import {
	buildLoomVideosQuery,
	lookupLoomVideos,
	toLoomVideoLookup,
} from "@/lib/loom-import/loom-api";
import { buildLoomImportReport } from "@/lib/loom-import/report";
import {
	countLoomImportItems,
	deriveLoomImportItemState,
	type LoomImportItemSource,
	type LoomImportItemView,
	type LoomImportSnapshot,
	loomImportProgress,
} from "@/lib/loom-import/status";

const source = (
	overrides: Partial<LoomImportItemSource>,
): LoomImportItemSource => ({
	status: "importing",
	videoId: "video-1",
	error: null,
	videoExists: true,
	uploadPhase: "processing",
	uploadProgress: 30,
	uploadMessage: "Processing video...",
	uploadError: null,
	...overrides,
});

describe("deriveLoomImportItemState", () => {
	it("shows checked rows as ready before an upgrade and queued once importing", () => {
		expect(
			deriveLoomImportItemState(
				source({ status: "ready" }),
				"awaiting_upgrade",
			),
		).toEqual({
			status: "ready",
		});
		expect(
			deriveLoomImportItemState(source({ status: "ready" }), "importing"),
		).toEqual({
			status: "queued",
		});
	});

	it("reads live media progress and friendly stages", () => {
		expect(deriveLoomImportItemState(source({}), "importing")).toEqual({
			status: "importing",
			stage: "processing",
			progress: 30,
		});
		expect(
			deriveLoomImportItemState(
				source({ uploadPhase: "uploading", uploadProgress: 0 }),
				"importing",
			).stage,
		).toBe("starting");
		expect(
			deriveLoomImportItemState(
				source({
					uploadMessage: "Queued for Loom import processing...",
					uploadProgress: 0,
				}),
				"importing",
			).stage,
		).toBe("waiting");
		expect(
			deriveLoomImportItemState(
				source({ uploadPhase: "generating_thumbnail", uploadProgress: 90 }),
				"importing",
			).stage,
		).toBe("finishing");
	});

	it("treats a finished upload as imported even if the job row lags behind", () => {
		expect(
			deriveLoomImportItemState(source({ uploadPhase: null }), "importing"),
		).toEqual({
			status: "imported",
		});
	});

	it("surfaces media errors, deleted Caps and retries started elsewhere", () => {
		expect(
			deriveLoomImportItemState(
				source({ uploadPhase: "error", uploadError: "Source unavailable" }),
				"importing",
			),
		).toEqual({ status: "failed", error: "Source unavailable" });
		expect(
			deriveLoomImportItemState(source({ videoExists: false }), "completed"),
		).toEqual({
			status: "failed",
			error: "The imported Cap was deleted.",
		});
		expect(
			deriveLoomImportItemState(
				source({ status: "failed", error: "Old failure" }),
				"completed",
			).status,
		).toBe("importing");
	});
});

describe("progress", () => {
	it("counts partial progress of videos that are mid-copy", () => {
		const counts = countLoomImportItems([
			{ status: "imported" },
			{ status: "failed" },
			{ status: "importing" },
			{ status: "queued" },
		]);
		expect(counts).toMatchObject({
			imported: 1,
			failed: 1,
			importing: 1,
			queued: 1,
			total: 4,
		});
		expect(loomImportProgress(counts, 50)).toBeCloseTo(0.625);
	});
});

describe("Loom lookups", () => {
	it("maps Loom's video types to import outcomes", () => {
		expect(
			toLoomVideoLookup({
				__typename: "RegularUserVideo",
				name: "  Weekly update ",
				createdAt: "2022-08-05T21:16:35.487Z",
				thumbnails: { default: "https://cdn.loom.com/thumb.jpg" },
				video_properties: { duration: 154, width: 1152, height: 720 },
			}),
		).toEqual({
			status: "ok",
			title: "Weekly update",
			createdAt: "2022-08-05T21:16:35.487Z",
			durationSeconds: 154,
			width: 1152,
			height: 720,
			thumbnailUrl: "https://cdn.loom.com/thumb.jpg",
		});
		expect(toLoomVideoLookup({ __typename: "PrivateVideo" })).toEqual({
			status: "private",
		});
		expect(
			toLoomVideoLookup({ __typename: "VideoPasswordMissingOrIncorrect" }),
		).toEqual({
			status: "password",
		});
		expect(toLoomVideoLookup(null)).toEqual({ status: "not_found" });
		for (const unsafe of [
			"javascript:alert(1)",
			"http://cdn.loom.com/thumb.jpg",
		]) {
			expect(
				toLoomVideoLookup({
					__typename: "RegularUserVideo",
					thumbnails: { default: unsafe },
				}),
			).toMatchObject({ status: "ok", thumbnailUrl: null });
		}
	});

	it("asks for many videos per request with aliases", () => {
		const query = buildLoomVideosQuery(["a", "b"]);
		expect(query.query).toContain("v0: getVideo(id: $id0");
		expect(query.query).toContain("v1: getVideo(id: $id1");
		expect(query.variables).toEqual({ id0: "a", id1: "b" });
	});

	it("batches lookups, retries a failed request and reports batches as they land", async () => {
		const ids = Array.from({ length: 60 }, (_, index) => `id${index}`);
		let calls = 0;
		const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
			calls++;
			if (calls === 1) return new Response("busy", { status: 503 });
			const { variables } = JSON.parse(String(init?.body)) as {
				variables: Record<string, string>;
			};
			const data = Object.fromEntries(
				Object.keys(variables).map((key) => [
					key.replace("id", "v"),
					{ __typename: "RegularUserVideo", name: variables[key] },
				]),
			);
			return Response.json({ data });
		}) as unknown as typeof fetch;
		const batches: number[] = [];
		const results = await lookupLoomVideos([...ids, "id0"], {
			fetchImpl,
			concurrency: 2,
			onBatch: (batch) => {
				batches.push(batch.size);
			},
		});
		expect(results.size).toBe(60);
		expect(batches.sort()).toEqual([10, 25, 25]);
		expect(fetchImpl).toHaveBeenCalledTimes(4);
		expect(results.get("id42")).toMatchObject({ status: "ok", title: "id42" });
	});

	it("gives up cleanly when Loom keeps failing", async () => {
		const fetchImpl = vi.fn(
			async () => new Response("no", { status: 500 }),
		) as unknown as typeof fetch;
		const results = await lookupLoomVideos(["a"], { fetchImpl, attempts: 2 });
		expect(results.get("a")).toEqual({ status: "error" });
	});
});

const view = (overrides: Partial<LoomImportItemView>): LoomImportItemView => ({
	id: "item-1",
	row: 2,
	url: "https://www.loom.com/share/abc",
	loomId: "abc",
	title: "Kickoff",
	email: "ana@acme.com",
	space: null,
	status: "imported",
	videoId: "video-1",
	recordedAt: "2022-08-05T21:16:35.487Z",
	duration: 154,
	thumb: null,
	v: 1,
	...overrides,
});

describe("results report", () => {
	it("maps every Loom link to its new Cap link and neutralizes spreadsheet formulas", () => {
		const csv = buildLoomImportReport(
			[
				view({}),
				view({
					id: "item-2",
					row: 3,
					title: '=HYPERLINK("x"), "quoted"',
					status: "failed",
					videoId: null,
					error: "This Loom is private.",
				}),
			],
			"https://cap.so",
		);
		expect(csv.split("\n")).toEqual([
			"row,loom_url,title,recorded_at,owner_email,space,status,cap_url,note",
			"2,https://www.loom.com/share/abc,Kickoff,2022-08-05T21:16:35.487Z,ana@acme.com,,imported,https://cap.so/s/video-1,",
			`3,https://www.loom.com/share/abc,"'=HYPERLINK(""x""), ""quoted""",2022-08-05T21:16:35.487Z,ana@acme.com,,failed,,This Loom is private.`,
			"",
		]);
	});
});

describe("mergeLoomImportItems", () => {
	const snapshot = (items: LoomImportItemView[], full: boolean) =>
		({ items, full, cursor: 0 }) as unknown as LoomImportSnapshot;

	it("replaces only rows that changed and keeps CSV order", () => {
		const map = new Map<string, LoomImportItemView>();
		const first = mergeLoomImportItems(
			map,
			[],
			snapshot([view({ id: "a", row: 2 }), view({ id: "b", row: 3 })], true),
		);
		expect(first).toEqual({ order: ["a", "b"], changed: true });
		const original = map.get("a");

		const unchanged = mergeLoomImportItems(
			map,
			first.order,
			snapshot([view({ id: "a", row: 2 })], false),
		);
		expect(unchanged.changed).toBe(false);
		expect(map.get("a")).toBe(original);

		const progressed = mergeLoomImportItems(
			map,
			first.order,
			snapshot(
				[view({ id: "b", row: 3, status: "importing", progress: 40, v: 2 })],
				false,
			),
		);
		expect(progressed).toEqual({ order: ["a", "b"], changed: true });
		expect(map.get("a")).toBe(original);
		expect(map.get("b")?.progress).toBe(40);
	});
});
