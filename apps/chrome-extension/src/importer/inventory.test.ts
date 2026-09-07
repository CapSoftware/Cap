import { describe, expect, it } from "vitest";
import {
	buildInventory,
	detectColumns,
	exportImportCsv,
	exportInventoryCsv,
	type InventoryOptions,
	type InventoryTable,
	MAX_FILE_BYTES,
	MAX_ROWS,
	parseInventory,
	toImportRows,
} from "./inventory";

const firstId = "0123456789abcdef0123456789abcdef";
const secondId = "fedcba9876543210fedcba9876543210";
const firstUrl = `https://www.loom.com/share/${firstId}`;
const secondUrl = `https://www.loom.com/share/${secondId}`;
const owner = "alex@example.test";
const options: InventoryOptions = {
	ownerEmail: "",
	spaceName: "",
	ownerMode: "column",
	spaceMode: "none",
};

function prepare(
	table: InventoryTable,
	overrides: Partial<InventoryOptions> = {},
) {
	return buildInventory(table, detectColumns(table.headers), {
		...options,
		...overrides,
	});
}

function tableFor(records: string[][]): InventoryTable {
	return { headers: ["Video Link", "Creator Email", "Video Name"], records };
}

describe("inventory parsing", () => {
	it("reads BOM, CRLF, quoted commas, escaped quotes, and multiline fields", () => {
		const table = parseInventory(
			`\uFEFFVideo Link,Video Name,Creator Email\r\n${firstUrl},"A, ""quoted""\r\nwalkthrough",${owner}\r\n`,
			"loom.CSV",
		);

		expect(table).toEqual({
			headers: ["Video Link", "Video Name", "Creator Email"],
			records: [[firstUrl, 'A, "quoted"\r\nwalkthrough', owner]],
		});
	});

	it("reads quoted tabs and CR-only records in TSV", () => {
		expect(
			parseInventory('title\towner\r"A\tB"\talex@example.test\r', "loom.tsv"),
		).toEqual({
			headers: ["title", "owner"],
			records: [["A\tB", owner]],
		});
	});

	it("detects tab-separated text when no known extension is supplied", () => {
		expect(
			parseInventory("title\towner\nDemo\talex@example.test", "inventory.txt")
				.records,
		).toEqual([["Demo", owner]]);
	});

	it("preserves original header spacing and pads short records", () => {
		expect(
			parseInventory(" URL ,Title,Owner\nvideo,Demo", "inventory.csv"),
		).toEqual({
			headers: [" URL ", "Title", "Owner"],
			records: [["video", "Demo", ""]],
		});
	});

	it("retains missing-link metadata records without deduplicating them", () => {
		const table = parseInventory(
			"Video Link,Video Name\n,Unlinked demo\n,Unlinked demo\n",
			"inventory.csv",
		);
		expect(table.records).toEqual([
			["", "Unlinked demo"],
			["", "Unlinked demo"],
		]);
	});

	it("retains interior empty records but creates no phantom EOF record", () => {
		expect(
			parseInventory(
				"Title,Owner\nOne,alex@example.test\n\nTwo,alex@example.test\n",
				"inventory.csv",
			).records,
		).toEqual([
			["One", owner],
			["", ""],
			["Two", owner],
		]);
	});

	it.each([
		'Header\n"unclosed',
		'Header\nfoo"bar',
		'Header\n"closed"unexpected',
		'Header\n "misplaced"',
	])("rejects malformed quotes: %s", (source) => {
		expect(() => parseInventory(source, "inventory.csv")).toThrow(
			/quotes|quoted/i,
		);
	});

	it("rejects overflowing records instead of silently dropping values", () => {
		expect(() => parseInventory("A,B\none,two,three", "inventory.csv")).toThrow(
			/Record 1 has more values/,
		);
	});

	it.each(["A,\none,two", "A,a\none,two", "A, A \none,two"])(
		"rejects blank or ambiguous headers: %s",
		(source) => {
			expect(() => parseInventory(source, "inventory.csv")).toThrow(/header/i);
		},
	);

	it.each(["", "\uFEFF", " \r\n\t", "A,B", "A,B\n", "A,B\n,\n,"])(
		"rejects empty or header-only input: %s",
		(source) => {
			expect(() => parseInventory(source, "inventory.csv")).toThrow(
				/empty|no data/i,
			);
		},
	);

	it("rejects files over the UTF-8 byte limit, not just character count", () => {
		expect(() =>
			parseInventory("x".repeat(MAX_FILE_BYTES + 1), "inventory.csv"),
		).toThrow(/10 MB/);
		expect(() =>
			parseInventory(
				`Header\n${"é".repeat(MAX_FILE_BYTES / 2)}`,
				"inventory.csv",
			),
		).toThrow(/10 MB/);
	});

	it("accepts the record limit and rejects the next record", () => {
		const source = `Header\n${"value\n".repeat(MAX_ROWS)}`;
		expect(parseInventory(source, "inventory.csv").records).toHaveLength(
			MAX_ROWS,
		);
		expect(() => parseInventory(`${source}extra`, "inventory.csv")).toThrow(
			/50,000 records/,
		);
	});

	it("bounds column padding before a huge header can exhaust memory", () => {
		const source = `${Array.from({ length: 257 }, (_, index) => `Column ${index}`).join(",")}\nvalue`;
		expect(() => parseInventory(source, "inventory.csv")).toThrow(
			/256 columns/,
		);
	});

	it("reads flat JSON records with stable union headers and scalar values", () => {
		const table = parseInventory(
			JSON.stringify([
				{ video_link: firstUrl, title: "Demo", duration: 30, approved: true },
				{ video_link: null, owner: owner, approved: false },
			]),
			"inventory.JSON",
		);

		expect(table).toEqual({
			headers: ["video_link", "title", "duration", "approved", "owner"],
			records: [
				[firstUrl, "Demo", "30", "true", ""],
				["", "", "", "false", owner],
			],
		});
	});

	it("reads the videos wrapper and detects JSON without an extension", () => {
		expect(
			parseInventory(`{ "videos": [{ "title": "Demo" }] }`, "inventory")
				.records,
		).toEqual([["Demo"]]);
	});

	it("does not read inherited object values for absent JSON keys", () => {
		expect(
			parseInventory(
				'[{"__proto__":"source","constructor":"plain"},{"title":"Demo"}]',
				"inventory.json",
			).records,
		).toEqual([
			["source", "plain", ""],
			["", "", "Demo"],
		]);
	});

	it.each([
		"not-json",
		"null",
		"{}",
		'{"videos":{}}',
		"[null]",
		"[1]",
		"[[1]]",
		'[{"title":{"nested":true}}]',
		'[{"title":["nested"]}]',
	])("rejects malformed or nested JSON: %s", (source) => {
		expect(() => parseInventory(source, "inventory.json")).toThrow(
			/JSON|flat|nested/i,
		);
	});

	it.each(["[]", '[{"title":null}]', '[{"title":""}]'])(
		"rejects JSON without data: %s",
		(source) => {
			expect(() => parseInventory(source, "inventory.json")).toThrow(
				/header|no data/i,
			);
		},
	);

	it("rejects too many JSON records before building the table", () => {
		const source = JSON.stringify(
			Array.from({ length: MAX_ROWS + 1 }, () => ({ title: "Demo" })),
		);
		expect(() => parseInventory(source, "inventory.json")).toThrow(
			/50,000 records/,
		);
	});

	it.each(['[{"id":9007199254740993}]', '[{"duration":1e400}]'])(
		"rejects unsafe JSON numbers instead of rounding source metadata: %s",
		(source) => {
			expect(() => parseInventory(source, "inventory.json")).toThrow(
				/unsafe number/,
			);
		},
	);

	it("does not mistake a bracket in a CSV header for JSON", () => {
		expect(
			parseInventory("[Video],Owner\nDemo,alex@example.test", "inventory.csv")
				.headers,
		).toEqual(["[Video]", "Owner"]);
	});
});

describe("column mapping", () => {
	it("recognizes native Loom columns and prefers Creator Email to Creator", () => {
		expect(
			detectColumns([
				"Video Name",
				"Creator",
				"Video Link",
				"Creator Email",
				"Created At",
				"Duration",
				"Folder",
			]),
		).toEqual({
			url: 2,
			title: 0,
			owner: 3,
			space: -1,
			createdAt: 4,
			duration: 5,
		});
	});

	it("recognizes canonical columns and review owner email", () => {
		expect(
			detectColumns(["loom_video_url", "user_email", "space_name"]).owner,
		).toBe(1);
		expect(
			detectColumns(["loom_video_url", "original_creator_email", "space_name"]),
		).toMatchObject({ url: 0, owner: 1, space: 2 });
		expect(detectColumns(["Creator"]).owner).toBe(0);
	});

	it("never silently maps folder paths or folder names into Cap Spaces", () => {
		expect(
			detectColumns(["Folder", "folder_path", "folder_name", "Space"]).space,
		).toBe(-1);
		expect(detectColumns([" Folder ", " SPACE NAME "]).space).toBe(1);
	});

	it("leaves unknown columns unset", () => {
		expect(detectColumns(["Unrelated"])).toEqual({
			url: -1,
			title: -1,
			owner: -1,
			space: -1,
			createdAt: -1,
			duration: -1,
		});
	});
});

describe("inventory preparation", () => {
	it.each([
		firstUrl,
		`http://loom.com/share/${firstId}/`,
		`https://loom.com/embed/${firstId}?sid=synthetic#section`,
		`https://www.loom.com/embed/${firstId.toUpperCase()}/?from=inventory`,
		`HTTPS://WWW.LOOM.COM/share/${firstId}`,
	])("canonicalizes supported Loom links: %s", (url) => {
		const [row] = prepare(tableFor([[url, owner, "Demo"]]));
		expect(row).toMatchObject({
			url: firstUrl,
			videoId: firstId,
			issue: null,
			sourceRecord: 1,
			index: 0,
		});
	});

	it.each([
		`https://loom.com.evil.test/share/${firstId}`,
		`https://evil-loom.com/share/${firstId}`,
		`https://cdn.loom.com/share/${firstId}`,
		`https://loom.com./share/${firstId}`,
		`https://%6coom.com/share/${firstId}`,
		`https://user:password@loom.com/share/${firstId}`,
		`https://@loom.com/share/${firstId}`,
		`https://www.loom.com:443/share/${firstId}`,
		`http://loom.com:80/share/${firstId}`,
		`ftp://loom.com/share/${firstId}`,
		`//loom.com/share/${firstId}`,
		`loom.com/share/${firstId}`,
		`https:////loom.com/share/${firstId}`,
		`https://loom.com\\share\\${firstId}`,
		`https://loom.com/share/${firstId}/extra`,
		`https://loom.com/share/${firstId}extra`,
		`https://loom.com/library/${firstId}`,
		"https://loom.com/share/short-id",
		`https://loom.com/share/${"g".repeat(32)}`,
		`https://loom.com/share/${firstId}?line\nbreak`,
		"javascript:alert(1)",
	])("rejects malformed, lookalike, or unsupported links: %s", (url) => {
		const [row] = prepare(tableFor([[url, owner, "Demo"]]));
		expect(row.issue).toBe("invalid-link");
		expect(row.videoId).toBeNull();
	});

	it("removes only native Loom text escaping and leaves the source intact", () => {
		const table: InventoryTable = {
			headers: [
				"Video Link",
				"Creator Email",
				"Video Name",
				"Created At",
				"Duration",
				"space_name",
			],
			records: [
				[
					firstUrl,
					"Alex\\@example.test",
					"Demo \\- A \\| B \\! C:\\files",
					"2026\\-01\\-02",
					"00:30",
					"Team \\| Notes",
				],
			],
		};
		const original = structuredClone(table);
		const [row] = prepare(table, { spaceMode: "column" });

		expect(row).toMatchObject({
			originalOwner: "Alex@example.test",
			ownerEmail: owner,
			title: "Demo - A | B \\! C:\\files",
			createdAt: "2026-01-02",
			duration: "00:30",
			spaceName: "Team | Notes",
			issue: null,
		});
		expect(table).toEqual(original);
		expect(row.raw).toEqual(original.records[0]);
		expect(row.raw).not.toBe(table.records[0]);
	});

	it("keeps original ownership when an explicit owner override is chosen", () => {
		const [row] = prepare(
			tableFor([[firstUrl, "source@example.test", "Demo"]]),
			{
				ownerMode: "override",
				ownerEmail: " Alex@Example.Test ",
				spaceMode: "override",
				spaceName: " Product / Guides ",
			},
		);
		expect(row).toMatchObject({
			originalOwner: "source@example.test",
			ownerEmail: owner,
			spaceName: "Product / Guides",
			issue: null,
		});
	});

	it("does not silently fall back to an override when column ownership is missing", () => {
		const [row] = prepare(tableFor([[firstUrl, "", "Demo"]]), {
			ownerEmail: owner,
		});
		expect(row.issue).toBe("invalid-owner");
		expect(row.ownerEmail).toBe("");
	});

	it.each([
		"",
		"Alex",
		"alex@example",
		"alex@@example.test",
		"alex @example.test",
		"alex\u0000@example.test",
		`${"x".repeat(256)}@example.test`,
	])("blocks invalid owner email: %s", (email) => {
		expect(prepare(tableFor([[firstUrl, email, "Demo"]]))[0].issue).toBe(
			"invalid-owner",
		);
	});

	it("leaves Spaces empty unless column or override mapping is explicitly selected", () => {
		const table = {
			headers: ["Video Link", "Creator", "space_name"],
			records: [[firstUrl, owner, "Product"]],
		};
		expect(prepare(table)[0].spaceName).toBe("");
		expect(prepare(table, { spaceMode: "column" })[0].spaceName).toBe(
			"Product",
		);
	});

	it("normalizes Space whitespace consistently before validating assignments", () => {
		const [row] = prepare(tableFor([[firstUrl, owner, "Demo"]]), {
			spaceMode: "override",
			spaceName: "  Product\t\n Guides  ",
		});
		expect(row.spaceName).toBe("Product Guides");
		expect(row.issue).toBeNull();
	});

	it.each([
		"x".repeat(256),
		"Product\u0000Guides",
		"Product\u007fGuides",
		"Product\u0080Guides",
	])("blocks invalid Space assignments: %s", (spaceName) => {
		const rows = prepare(tableFor([[firstUrl, owner, "Demo"]]), {
			spaceMode: "override",
			spaceName,
		});
		expect(rows[0].issue).toBe("invalid-space");
		expect(() => toImportRows(rows)).toThrow(/255 characters/);
	});

	it("does not guess links or IDs from titles, other metadata, or repeated missing records", () => {
		const rows = prepare(
			tableFor([
				["", owner, firstId],
				["", owner, firstId],
				["", owner, firstUrl],
			]),
		);
		expect(rows.map((row) => row.issue)).toEqual([
			"missing-link",
			"missing-link",
			"missing-link",
		]);
		expect(rows.map((row) => row.videoId)).toEqual([null, null, null]);
		expect(rows.map((row) => row.sourceRecord)).toEqual([1, 2, 3]);
	});

	it("marks later duplicates across share and embed URLs while retaining every source record", () => {
		const rows = prepare(
			tableFor([
				[firstUrl, owner, "First"],
				[
					`https://loom.com/embed/${firstId.toUpperCase()}?x=1`,
					owner,
					"Second",
				],
				[secondUrl, owner, "Third"],
			]),
		);
		expect(rows.map((row) => row.issue)).toEqual([null, "duplicate", null]);
		expect(rows[1].detail).toContain("record 1");
		expect(rows[1].title).toBe("Second");
	});

	it("does not hide first-record ownership problems by substituting a later duplicate", () => {
		const rows = prepare(
			tableFor([
				[firstUrl, "", "First"],
				[firstUrl, owner, "Later"],
			]),
		);
		expect(rows.map((row) => row.issue)).toEqual([
			"invalid-owner",
			"duplicate",
		]);
	});

	it.each([
		"",
		" ",
		"pending",
		"excluded",
		"rejected",
		"false",
		"no",
		"unknown",
		"0",
		"future-status",
	])("requires explicit review for decision %s", (decision) => {
		const table = {
			headers: ["Video Link", "Creator", "review_decision"],
			records: [[firstUrl, owner, decision]],
		};
		expect(prepare(table)[0]).toMatchObject({
			issue: null,
			reviewRequired: true,
		});
	});

	it.each(["approved", "include", "yes", "true", " APPROVED "])(
		"permits automatic selection for decision %s",
		(decision) => {
			const table = {
				headers: ["Video Link", "Creator", "decision"],
				records: [[firstUrl, owner, decision]],
			};
			expect(prepare(table)[0].reviewRequired).toBe(false);
		},
	);

	it("fails closed when multiple review columns disagree", () => {
		const table = {
			headers: ["Video Link", "Creator", "import", "Include"],
			records: [[firstUrl, owner, "yes", "no"]],
		};
		expect(prepare(table)[0].reviewRequired).toBe(true);
	});

	it.each(["cap_import_status", "_cap_import_status", "__CAP_IMPORT_STATUS"])(
		"requires explicit review when reopening an audit report with %s",
		(header) => {
			for (const state of [
				"not-submitted",
				"started",
				"existing",
				"uncertain",
			]) {
				const table = {
					headers: ["Video Link", "Creator", header],
					records: [[firstUrl, owner, state]],
				};
				expect(prepare(table)[0].reviewRequired).toBe(true);
			}
		},
	);
});

describe("import preparation and exports", () => {
	it("produces only the canonical submission fields with optional Space", () => {
		const rows = prepare(tableFor([[firstUrl, owner, "Demo"]]));
		expect(toImportRows(rows)).toEqual([
			{ loom_video_url: firstUrl, user_email: owner },
		]);
		expect(
			toImportRows(
				prepare(tableFor([[firstUrl, owner, "Demo"]]), {
					spaceMode: "override",
					spaceName: "Product",
				}),
			),
		).toEqual([
			{ loom_video_url: firstUrl, user_email: owner, space_name: "Product" },
		]);
		expect(toImportRows([])).toEqual([]);
	});

	it("rejects any invalid selected record rather than silently filtering it out", () => {
		const rows = prepare(
			tableFor([
				[firstUrl, owner, "Demo"],
				["", owner, "Missing"],
			]),
		);
		expect(() => toImportRows(rows)).toThrow(/Record 2 is not ready/);
		expect(() => exportImportCsv(rows)).toThrow(/Record 2 is not ready/);
		expect(toImportRows([rows[0]])).toHaveLength(1);
	});

	it("revalidates prepared URLs and owner emails at the submission boundary", () => {
		const [row] = prepare(tableFor([[firstUrl, owner, "Demo"]]));
		expect(() => toImportRows([{ ...row, url: "https://evil.test" }])).toThrow(
			/not ready/,
		);
		expect(() => toImportRows([{ ...row, ownerEmail: "invalid" }])).toThrow(
			/not ready/,
		);
	});

	it("permits reviewed records only when the caller explicitly supplies them", () => {
		const table = {
			headers: ["Video Link", "Creator", "decision"],
			records: [[firstUrl, owner, "pending"]],
		};
		const rows = prepare(table);
		expect(rows[0].reviewRequired).toBe(true);
		expect(toImportRows(rows)).toHaveLength(1);
	});

	it("allows exports larger than one 500-record API batch", () => {
		const table = tableFor(
			Array.from({ length: 501 }, (_, index) => [
				`https://loom.com/share/${index.toString(16).padStart(32, "0")}`,
				owner,
				"Demo",
			]),
		);
		const rows = prepare(table);
		expect(toImportRows(rows)).toHaveLength(501);
		expect(
			parseInventory(exportImportCsv(rows), "ready.csv").records,
		).toHaveLength(501);
	});

	it("exports BOM and exactly three canonical columns with RFC escaping", () => {
		const rows = prepare(tableFor([[firstUrl, owner, "Not exported"]]), {
			spaceMode: "override",
			spaceName: 'Product, "Guides"\nTeam',
		});
		const csv = exportImportCsv(rows);
		expect(
			csv.startsWith("\uFEFFloom_video_url,user_email,space_name\r\n"),
		).toBe(true);
		expect(parseInventory(csv, "ready.csv")).toEqual({
			headers: ["loom_video_url", "user_email", "space_name"],
			records: [[firstUrl, owner, 'Product, "Guides" Team']],
		});
	});

	it.each([
		"+owner@example.test",
		"-owner@example.test",
		"=owner@example.test",
	])(
		"preserves %s for direct import but rejects assignment-changing CSV escaping",
		(email) => {
			const rows = prepare(tableFor([[firstUrl, email, "Demo"]]));
			expect(toImportRows(rows)[0].user_email).toBe(email);
			expect(() => exportImportCsv(rows)).toThrow(
				/spreadsheet formula character/,
			);
		},
	);

	it.each(["-Notes", "+Notes", "@Notes", "=SUM(1,2)", " \t=SUM(1,2)"])(
		"preserves Space %s for direct import but rejects dangerous canonical CSV",
		(spaceName) => {
			const rows = prepare(tableFor([[firstUrl, owner, "Demo"]]), {
				spaceMode: "override",
				spaceName,
			});
			expect(toImportRows(rows)[0].space_name).toBe(spaceName.trim());
			expect(() => exportImportCsv(rows)).toThrow(/import directly into Cap/);
		},
	);

	it("exports every original record and maps prepared fields by stable index", () => {
		const table = tableFor([
			[firstUrl, owner, "First"],
			["", owner, "Missing"],
			[firstUrl, owner, "Duplicate"],
		]);
		const rows = prepare(table);
		const exported = parseInventory(
			exportInventoryCsv(table, [...rows].reverse()),
			"audit.csv",
		);
		expect(exported.records.map((record) => record.slice(0, 3))).toEqual(
			table.records,
		);
		const sourceColumn = exported.headers.indexOf("source_record_number");
		const statusColumn = exported.headers.indexOf("validation_status");
		expect(exported.records.map((record) => record[sourceColumn])).toEqual([
			"1",
			"2",
			"3",
		]);
		expect(exported.records.map((record) => record[statusColumn])).toEqual([
			"ready",
			"missing-link",
			"duplicate",
		]);
	});

	it("prefixes generated headers until they do not collide with source headers", () => {
		const table = {
			headers: [
				"Video Link",
				"Creator",
				"source_record_number",
				"cap_source_record_number",
				" Prepared_User_Email ",
			],
			records: [[firstUrl, owner, "source", "also source", "original"]],
		};
		const exported = parseInventory(
			exportInventoryCsv(table, prepare(table)),
			"audit.csv",
		);
		expect(exported.headers.slice(0, table.headers.length)).toEqual(
			table.headers,
		);
		expect(exported.headers).toContain("cap_cap_source_record_number");
		expect(exported.headers).toContain("cap_prepared_user_email");
		expect(exported.records[0].slice(0, 5)).toEqual(table.records[0]);
	});

	it.each([
		"=1+1",
		"+cmd",
		"-cmd",
		"@cmd",
		"  =1+1",
		"\t=1+1",
		" \t@cmd",
		"\tplain",
		"\rplain",
		"\nplain",
		"\u0000=1+1",
		"\u0080@cmd",
	])(
		"neutralizes formula-like raw metadata in an audit export: %s",
		(value) => {
			const table = tableFor([[firstUrl, owner, value]]);
			const exported = parseInventory(
				exportInventoryCsv(table, prepare(table)),
				"audit.csv",
			);
			expect(exported.records[0][2]).toBe(`'${value}`);
			expect(table.records[0][2]).toBe(value);
		},
	);

	it("neutralizes formula-like source headers and prepared assignments in audit exports", () => {
		const table = {
			headers: ["Video Link", "Creator", "=header"],
			records: [[firstUrl, "+owner@example.test", "plain"]],
		};
		const rows = prepare(table, { spaceMode: "override", spaceName: "-Notes" });
		const exported = parseInventory(
			exportInventoryCsv(table, rows),
			"audit.csv",
		);
		expect(exported.headers[2]).toBe("'=header");
		expect(
			exported.records[0][exported.headers.indexOf("prepared_user_email")],
		).toBe("'+owner@example.test");
		expect(
			exported.records[0][exported.headers.indexOf("prepared_space_name")],
		).toBe("'-Notes");
	});

	it("retains unprepared source records and marks them as needing review", () => {
		const table = tableFor([
			[firstUrl, owner, "First"],
			[secondUrl, owner, "Second"],
		]);
		const exported = parseInventory(
			exportInventoryCsv(table, [prepare(table)[0]]),
			"audit.csv",
		);
		expect(exported.records).toHaveLength(2);
		expect(
			exported.records[1][exported.headers.indexOf("validation_status")],
		).toBe("not-prepared");
		expect(
			exported.records[1][exported.headers.indexOf("review_required")],
		).toBe("true");
	});

	it("rejects ambiguous prepared indexes instead of overwriting audit records", () => {
		const table = tableFor([[firstUrl, owner, "First"]]);
		const [row] = prepare(table);
		expect(() => exportInventoryCsv(table, [row, row])).toThrow(
			/does not match/,
		);
		expect(() => exportInventoryCsv(table, [{ ...row, index: 2 }])).toThrow(
			/does not match/,
		);
	});
});
