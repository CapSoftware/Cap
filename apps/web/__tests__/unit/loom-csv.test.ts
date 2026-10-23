import { describe, expect, it } from "vitest";
import {
	formatLoomCsvCell,
	parseConciergeLoomCsv,
	parseLoomCsvRecords,
	readLoomCsvCell,
} from "@/lib/loom-csv";

describe("concierge Loom CSV", () => {
	it("keeps quoted workspace names and source row numbers", () => {
		const rows = parseConciergeLoomCsv(
			"\uFEFFuser_email,space_name,loom_video_url\r\n" +
				"owner@example.com," +
				JSON.stringify("Sales, Europe") +
				",https://www.loom.com/share/0123456789abcdef\r\n",
		);
		expect(rows).toEqual([
			{
				rowNumber: 2,
				loomUrl: "https://www.loom.com/share/0123456789abcdef",
				userEmail: "owner@example.com",
				spaceName: "Sales, Europe",
			},
		]);
	});

	it("rejects a file without the mapping columns", () => {
		expect(() => parseConciergeLoomCsv("url,email\nlink,person@x.com")).toThrow(
			"loom_video_url and user_email",
		);
	});
});

describe("Loom CSV results cells", () => {
	it("keeps plain values unchanged", () => {
		expect(formatLoomCsvCell("owner@example.com")).toBe("owner@example.com");
		expect(
			formatLoomCsvCell("https://www.loom.com/share/0123456789abcdef"),
		).toBe("https://www.loom.com/share/0123456789abcdef");
	});

	it("quotes delimiters and doubles embedded quotes", () => {
		expect(formatLoomCsvCell("Sales, Europe")).toBe('"Sales, Europe"');
		expect(formatLoomCsvCell('The "A" team')).toBe('"The ""A"" team"');
	});

	it.each([
		["=HYPERLINK(1)", "'=HYPERLINK(1)"],
		["+1", "'+1"],
		["-1", "'-1"],
		["@SUM(A1)", "'@SUM(A1)"],
		["\tTab", "'\tTab"],
	])("neutralizes the formula prefix in %j", (value, expected) => {
		expect(formatLoomCsvCell(value)).toBe(expected);
	});

	it("neutralizes formulas that also need quoting", () => {
		expect(formatLoomCsvCell("=1,2")).toBe(`"'=1,2"`);
		expect(formatLoomCsvCell("\r=1")).toBe(`"'\r=1"`);
	});
});

describe("Loom CSV results round trip", () => {
	it("restores neutralized values when a results CSV is imported again", () => {
		const values = ["@Sales", "+owner@example.com", "-Ops, EU", "=1"];
		const [cells] = parseLoomCsvRecords(
			`${values.map(formatLoomCsvCell).join(",")}\n`,
		);
		expect(cells?.map(readLoomCsvCell)).toEqual(values);
	});

	it("leaves other leading apostrophes alone", () => {
		expect(readLoomCsvCell("'Sales")).toBe("'Sales");
		expect(readLoomCsvCell("O'Brien")).toBe("O'Brien");
	});
});
