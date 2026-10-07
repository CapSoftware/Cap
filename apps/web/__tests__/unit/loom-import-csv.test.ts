import { describe, expect, it } from "vitest";
import {
	buildLoomImportPlan,
	detectLoomImportMapping,
	extractLoomVideoId,
	LOOM_IMPORT_MAX_ROWS,
	parseCsv,
	parseCsvRecords,
	tableFromPastedLinks,
} from "@/lib/loom-import/csv";

const ID_A = "0dd0a01e10c742b28dbea75082c08635";
const ID_B = "31f430c1a1e744b8a7b6c18a26982c71";

describe("parseCsvRecords", () => {
	it("handles quotes, escaped quotes, embedded newlines and CRLF", () => {
		const text =
			'\uFEFFtitle,link\r\n"Quarterly ""all hands""",https://www.loom.com/share/a\r\n"Line one\nline two",https://www.loom.com/share/b\r\n';
		expect(parseCsvRecords(text)).toEqual([
			["title", "link"],
			['Quarterly "all hands"', "https://www.loom.com/share/a"],
			["Line one\nline two", "https://www.loom.com/share/b"],
		]);
	});

	it("keeps blank lines so row numbers match the spreadsheet, and rejects unclosed quotes", () => {
		expect(parseCsvRecords("a,,c\n\n,,\nd,e,\n\n,,\n")).toEqual([
			["a", "", "c"],
			[""],
			["", "", ""],
			["d", "e", ""],
		]);
		expect(() => parseCsvRecords('a,"unfinished\n')).toThrow("unclosed");
	});
});

describe("parseCsv", () => {
	it("detects semicolon and tab separated exports", () => {
		expect(
			parseCsv("Video URL;Owner\nhttps://loom.com/share/x;a@b.co").rows,
		).toEqual([["https://loom.com/share/x", "a@b.co"]]);
		expect(
			parseCsv("Video URL\tOwner\nhttps://loom.com/share/x\ta@b.co").delimiter,
		).toBe("\t");
	});

	it("treats a plain list of Loom links as rows instead of a header", () => {
		const table = parseCsv(
			`https://www.loom.com/share/${ID_A}\nhttps://www.loom.com/share/${ID_B}\n`,
		);
		expect(table.headerless).toBe(true);
		expect(table.rows).toHaveLength(2);
	});
});

describe("extractLoomVideoId", () => {
	it.each([
		[`https://www.loom.com/share/${ID_A}`, ID_A],
		[`https://www.loom.com/share/${ID_A}?sid=123#t=10`, ID_A],
		[`https://www.loom.com/embed/${ID_A}`, ID_A],
		[`https://loom.com/share/Weekly-update-for-the-team-${ID_A}`, ID_A],
		[`www.loom.com/share/${ID_A.toUpperCase()}`, ID_A],
		[ID_B, ID_B],
	])("reads %s", (value, expected) => {
		expect(extractLoomVideoId(value)).toBe(expected);
	});

	it.each([
		"",
		"https://example.com/share/0dd0a01e10c742b28dbea75082c08635",
		"https://www.loom.com/",
		"https://notloom.com/share/0dd0a01e10c742b28dbea75082c08635",
		"just some text",
	])("ignores %s", (value) => {
		expect(extractLoomVideoId(value)).toBeNull();
	});
});

describe("detectLoomImportMapping", () => {
	it("finds columns by their values when headers are unfamiliar", () => {
		const table = parseCsv(
			[
				"Name,Recorder,Where,Recording",
				`Kickoff,ana@acme.com,Sales,https://www.loom.com/share/${ID_A}`,
				`Demo,sam@acme.com,Sales,https://www.loom.com/share/${ID_B}`,
			].join("\n"),
		);
		expect(detectLoomImportMapping(table)).toEqual({
			loomUrl: 3,
			ownerEmail: 1,
			spaceName: undefined,
		});
	});

	it("maps the Cap template and Loom style exports", () => {
		const template = parseCsv(
			`loom_video_url,user_email,space_name\nhttps://www.loom.com/share/${ID_A},a@b.co,Sales`,
		);
		expect(detectLoomImportMapping(template)).toEqual({
			loomUrl: 0,
			ownerEmail: 1,
			spaceName: 2,
		});
		const loomExport = parseCsv(
			`Video ID,Video Title,Creator Email,Workspace\n${ID_A},Intro,a@b.co,Acme`,
		);
		expect(detectLoomImportMapping(loomExport)).toEqual({
			loomUrl: 0,
			ownerEmail: 2,
			spaceName: undefined,
		});
	});
});

describe("buildLoomImportPlan", () => {
	const table = parseCsv(
		[
			"loom_video_url,user_email,space_name",
			`https://www.loom.com/share/${ID_A},Ana@Acme.com,  Sales  Team `,
			"https://example.com/video,ana@acme.com,",
			`https://www.loom.com/share/${ID_B},not-an-email,`,
			`https://www.loom.com/share/${ID_A},sam@acme.com,`,
			",,",
			`${ID_B},sam@acme.com,Design`,
		].join("\n"),
	);

	it("explains every row it leaves out and normalizes the rest", () => {
		const plan = buildLoomImportPlan(table, detectLoomImportMapping(table), {
			allowOwners: true,
		});
		expect(plan.rows).toEqual([
			{
				rowNumber: 2,
				loomUrl: `https://www.loom.com/share/${ID_A}`,
				ownerEmail: "ana@acme.com",
				spaceName: "Sales Team",
			},
			{
				rowNumber: 7,
				loomUrl: `https://www.loom.com/share/${ID_B}`,
				ownerEmail: "sam@acme.com",
				spaceName: "Design",
			},
		]);
		expect(plan.issues.map((issue) => [issue.rowNumber, issue.reason])).toEqual(
			[
				[3, "not_loom"],
				[4, "bad_email"],
				[5, "duplicate"],
			],
		);
		expect(plan.issues[2]?.duplicateOf).toBe(2);
		expect(plan).toMatchObject({ owners: 2, spaces: 2, overLimit: false });
	});

	it("ignores owners and spaces for people who can only import for themselves", () => {
		const plan = buildLoomImportPlan(table, detectLoomImportMapping(table), {
			allowOwners: false,
		});
		expect(plan.rows.map((row) => [row.rowNumber, row.ownerEmail])).toEqual([
			[2, undefined],
			[4, undefined],
		]);
		expect(plan.issues.map((issue) => [issue.rowNumber, issue.reason])).toEqual(
			[
				[3, "not_loom"],
				[5, "duplicate"],
				[7, "duplicate"],
			],
		);
	});

	it("flags files over the per-import limit", () => {
		const rows = Array.from(
			{ length: LOOM_IMPORT_MAX_ROWS + 1 },
			(_, index) => [
				`https://www.loom.com/share/${index.toString(16).padStart(32, "0")}`,
			],
		);
		const plan = buildLoomImportPlan(
			{ headers: ["url"], rows, delimiter: ",", headerless: false },
			{ loomUrl: 0 },
			{ allowOwners: true },
		);
		expect(plan.overLimit).toBe(true);
	});

	it("parses and plans 2,000 rows quickly", () => {
		const csv = [
			"Video Title,Video URL,Creator Email,Space",
			...Array.from(
				{ length: 2000 },
				(_, index) =>
					`"Weekly update, part ${index}",https://www.loom.com/share/${index.toString(16).padStart(32, "0")},person${index % 40}@acme.com,Team ${index % 7}`,
			),
		].join("\n");
		const startedAt = performance.now();
		const parsed = parseCsv(csv);
		const plan = buildLoomImportPlan(parsed, detectLoomImportMapping(parsed), {
			allowOwners: true,
		});
		const elapsed = performance.now() - startedAt;
		expect(plan.rows).toHaveLength(2000);
		expect(plan.owners).toBe(40);
		expect(plan.spaces).toBe(7);
		expect(elapsed).toBeLessThan(250);
	});
});

describe("tableFromPastedLinks", () => {
	it("pulls Loom links out of free text", () => {
		const table = tableFromPastedLinks(
			`Here you go: https://www.loom.com/share/${ID_A}. And (https://loom.com/share/${ID_B})\nthanks!`,
		);
		expect(table.rows).toEqual([
			[`https://www.loom.com/share/${ID_A}`],
			[`https://loom.com/share/${ID_B}`],
		]);
	});

	it("accepts bare Loom video ids", () => {
		expect(tableFromPastedLinks(`${ID_A}\n${ID_B}`).rows).toEqual([
			[ID_A],
			[ID_B],
		]);
	});
});
