import { describe, expect, it } from "vitest";
import {
	buildLoomImportPlan,
	decodeLoomImportRows,
	detectLoomImportMapping,
	encodeLoomImportRows,
	LOOM_IMPORT_MAX_ROWS,
	parseCsv,
} from "@/lib/loom-import/csv";
import { loomRetryDelayMs } from "@/lib/loom-import/loom-api";
import {
	addLoomImportLoad,
	type LoomImportQueueJob,
	type LoomImportQueueLoad,
	pickLoomImportJob,
} from "@/lib/loom-import/schedule";
import { summarizeLoomImportItems } from "@/lib/loom-import/status";

const job = (
	id: string,
	creatorId: string,
	overrides: Partial<LoomImportQueueJob> = {},
): LoomImportQueueJob => ({
	id,
	creatorId,
	dispatchedAt: null,
	startedAt: new Date(`2026-10-07T00:00:0${id.length}Z`),
	...overrides,
});

const emptyLoad = (): LoomImportQueueLoad => ({
	jobs: new Map(),
	creators: new Map(),
});

function allocate(
	jobs: LoomImportQueueJob[],
	slots: number,
	perJob: number,
	load = emptyLoad(),
) {
	const picks: string[] = [];
	for (let slot = 0; slot < slots; slot++) {
		const next = pickLoomImportJob(jobs, load, perJob);
		if (!next) break;
		picks.push(next.id);
		addLoomImportLoad(load, next);
	}
	return picks;
}

describe("pickLoomImportJob", () => {
	it("shares slots between people before giving anyone a second one", () => {
		const jobs = [
			job("a1", "ana"),
			job("a2", "ana"),
			job("a3", "ana"),
			job("b1", "ben"),
			job("c1", "cy"),
		];
		const picks = allocate(jobs, 6, 4);
		expect(picks.slice(0, 3).sort()).toEqual(["a1", "b1", "c1"]);
		const perPerson = new Map<string, number>();
		for (const id of picks) {
			const creator = jobs.find((candidate) => candidate.id === id)?.creatorId;
			if (creator) perPerson.set(creator, (perPerson.get(creator) ?? 0) + 1);
		}
		expect([...perPerson.values()].sort()).toEqual([2, 2, 2]);
	});

	it("never gives one import more than its own limit", () => {
		expect(allocate([job("a1", "ana")], 10, 4)).toEqual([
			"a1",
			"a1",
			"a1",
			"a1",
		]);
	});

	it("serves the import that waited longest when everyone is even", () => {
		const jobs = [
			job("served", "ana", { dispatchedAt: new Date("2026-10-07T10:00:00Z") }),
			job("waiting", "ben", {
				dispatchedAt: new Date("2026-10-07T09:00:00Z"),
			}),
			job("new", "cy"),
		];
		expect(allocate(jobs, 1, 4)).toEqual(["new"]);
		expect(allocate(jobs.slice(0, 2), 1, 4)).toEqual(["waiting"]);
	});

	it("rotates through 50 imports when only 12 can copy at once", () => {
		const jobs = Array.from({ length: 50 }, (_, index) =>
			job(`job-${String(index).padStart(2, "0")}`, `person-${index}`),
		);
		const served = new Map<string, number>();
		const load = emptyLoad();
		let clock = 0;
		const inFlight: string[] = [];
		for (let step = 0; step < 500; step++) {
			while (inFlight.length < 12) {
				const next = pickLoomImportJob(jobs, load, 4);
				if (!next) break;
				addLoomImportLoad(load, next);
				next.dispatchedAt = new Date(++clock);
				inFlight.push(next.id);
				served.set(next.id, (served.get(next.id) ?? 0) + 1);
			}
			const finished = inFlight.shift();
			const owner = jobs.find((candidate) => candidate.id === finished);
			if (owner) {
				load.jobs.set(owner.id, (load.jobs.get(owner.id) ?? 1) - 1);
				load.creators.set(
					owner.creatorId,
					(load.creators.get(owner.creatorId) ?? 1) - 1,
				);
			}
		}
		const counts = [...served.values()];
		expect(served.size).toBe(50);
		expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
	});
});

describe("loomRetryDelayMs", () => {
	it("backs off further when Loom says it is rate limiting", () => {
		expect(loomRetryDelayMs(0, null, () => 0)).toBe(400);
		expect(loomRetryDelayMs(2, null, () => 0)).toBe(1600);
		expect(loomRetryDelayMs(0, "", () => 0)).toBe(2000);
		expect(loomRetryDelayMs(1, "", () => 0)).toBe(4000);
		expect(loomRetryDelayMs(0, "7", () => 0)).toBe(7000);
		expect(loomRetryDelayMs(0, "600", () => 0)).toBe(10_000);
		expect(loomRetryDelayMs(0, "7", () => 1)).toBe(10_500);
	});
});

describe("compact import rows", () => {
	it("round trips owners, spaces and canonical links", () => {
		const table = parseCsv(
			[
				"Video URL,Creator Email,Space",
				"https://www.loom.com/share/My-Demo-0dd0a01e10c742b28dbea75082c08635?sid=1,ana@acme.com,Sales",
				"https://www.loom.com/share/31f430c1a1e744b8a7b6c18a26982c71,ana@acme.com,",
				"2bff5385f32643ea9d065227ebfadd0d,,Sales",
			].join("\n"),
		);
		const plan = buildLoomImportPlan(table, detectLoomImportMapping(table), {
			allowOwners: true,
		});
		const payload = encodeLoomImportRows(plan.rows);
		expect(payload).toEqual({
			owners: ["ana@acme.com"],
			spaces: ["Sales"],
			rows: [
				[2, "0dd0a01e10c742b28dbea75082c08635", 0, 0],
				[3, "31f430c1a1e744b8a7b6c18a26982c71", 0, -1],
				[4, "2bff5385f32643ea9d065227ebfadd0d", -1, 0],
			],
		});
		expect(decodeLoomImportRows(JSON.parse(JSON.stringify(payload)))).toEqual([
			{
				rowNumber: 2,
				loomUrl: "https://www.loom.com/share/0dd0a01e10c742b28dbea75082c08635",
				ownerEmail: "ana@acme.com",
				spaceName: "Sales",
			},
			{
				rowNumber: 3,
				loomUrl: "https://www.loom.com/share/31f430c1a1e744b8a7b6c18a26982c71",
				ownerEmail: "ana@acme.com",
			},
			{
				rowNumber: 4,
				loomUrl: "https://www.loom.com/share/2bff5385f32643ea9d065227ebfadd0d",
				spaceName: "Sales",
			},
		]);
	});

	it("rejects payloads that are not import rows and keeps bad rows visible", () => {
		expect(decodeLoomImportRows(null)).toBeNull();
		expect(decodeLoomImportRows({ rows: [] })).toBeNull();
		expect(
			decodeLoomImportRows({
				owners: ["a@b.co"],
				spaces: [],
				rows: [["x", 5, 9, "y"], "nope"],
			}),
		).toEqual([
			{ rowNumber: 1, loomUrl: "" },
			{ rowNumber: 2, loomUrl: "" },
		]);
	});

	it("keeps a full 2,000 video import far below the 1 MB request limit", () => {
		const rows = Array.from({ length: LOOM_IMPORT_MAX_ROWS }, (_, index) => ({
			rowNumber: index + 2,
			loomUrl: `https://www.loom.com/share/A-very-long-video-title-that-loom-adds-to-links-${index.toString(16).padStart(32, "0")}?sid=0123456789abcdef0123456789abcdef`,
			ownerEmail: `person-${index % 200}@a-company-with-a-long-domain.example.com`,
			spaceName: `Customer success and onboarding ${index % 40}`,
		}));
		const bytes = new TextEncoder().encode(
			JSON.stringify(encodeLoomImportRows(rows)),
		).length;
		const naive = new TextEncoder().encode(JSON.stringify(rows)).length;
		expect(bytes).toBeLessThan(150_000);
		expect(naive).toBeGreaterThan(bytes * 3);
	});
});

describe("summarizeLoomImportItems", () => {
	it("counts rows, owners and minutes the same way on server and client", () => {
		expect(
			summarizeLoomImportItems([
				{ status: "imported", duration: 60, email: "a@b.co" },
				{ status: "importing", duration: 30, email: "c@d.co" },
				{ status: "failed", duration: 90, email: "a@b.co" },
				{ status: "queued", duration: null, email: null },
			]),
		).toEqual({
			counts: {
				checking: 0,
				ready: 0,
				queued: 1,
				importing: 1,
				imported: 1,
				failed: 1,
				skipped: 0,
				cancelled: 0,
				total: 4,
			},
			totalDuration: 90,
			importedDuration: 60,
			owners: 2,
		});
	});
});
