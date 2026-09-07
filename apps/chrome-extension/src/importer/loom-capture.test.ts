import { describe, expect, it } from "vitest";
import { parseInventory } from "./inventory";
import { type LoomExportSource, prepareLoomCapture } from "./loom-capture";
import { capOrigin } from "./migration-api";

const link = "https://www.loom.com/share/0123456789abcdef0123456789abcdef";
const headers =
	"Video Link,Video Name,Creator Email,Workspace,Folder,Video Creation Date";
const source: LoomExportSource = {
	workspace: "Example team",
	from: "1970-01-01",
	to: "2026-09-02",
	totalRows: 3,
};
const csv = `${headers}\n${link},Demo,owner\\@example.test,Can Edit,Private / Guides,09/01/2026\n,,other@example.test,No Access,,09/02/2026\n${link},Duplicate,owner@example.test,Can View,Private / Guides,09/01/2026`;

describe("Loom account capture", () => {
	it("builds a canonical CSV while preserving omitted and duplicate source records", () => {
		const result = prepareLoomCapture(csv, source);
		expect(result.eligible).toHaveLength(1);
		expect(result.omittedRows).toBe(2);
		expect(result.rows.map((row) => row.issue)).toEqual([
			null,
			"missing-link",
			"duplicate",
		]);
		expect(parseInventory(result.importCsv, "import.csv").records).toEqual([
			[link, "owner@example.test", ""],
		]);
		expect(parseInventory(result.reportCsv, "report.csv").records).toHaveLength(
			3,
		);
		expect(result.rows[0]).toMatchObject({
			spaceName: "",
			createdAt: "09/01/2026",
		});
		expect(result.table.records[0]?.[4]).toBe("Private / Guides");
		expect(result.table.records.map((row) => row[3])).toEqual([
			"Can Edit",
			"No Access",
			"Can View",
		]);
		expect(result.source.workspace).toBe("Example team");
	});
	it("rejects truncated reports before any handoff", () => {
		expect(() => prepareLoomCapture(csv, { ...source, totalRows: 4 })).toThrow(
			"returned 3 records",
		);
	});
	it("requires the native engagement inventory schema", () => {
		expect(() =>
			prepareLoomCapture(
				`loom_video_url,user_email\n${link},owner@example.test`,
				{ ...source, totalRows: 1 },
			),
		).toThrow("CSV format has changed");
	});
	it("keeps an entirely inaccessible report available without importable rows", () => {
		const result = prepareLoomCapture(
			`${headers}\n,,owner@example.test,No Access,,09/02/2026`,
			{ ...source, totalRows: 1 },
		);
		expect(result.eligible).toEqual([]);
		expect(result.omittedRows).toBe(1);
		expect(result.reportCsv).toContain("missing-link");
	});
	it("accepts secure self-hosted Cap and local development but never credentials or insecure remote origins", () => {
		expect(capOrigin("https://cap.example.test/base")).toBe(
			"https://cap.example.test",
		);
		expect(capOrigin("http://localhost:3000")).toBe("http://localhost:3000");
		expect(() => capOrigin("https://user:password@cap.example.test")).toThrow(
			"secure Cap URL",
		);
		expect(() => capOrigin("http://cap.example.test")).toThrow(
			"secure Cap URL",
		);
	});
});
