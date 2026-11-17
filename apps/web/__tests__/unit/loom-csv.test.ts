import { describe, expect, it } from "vitest";
import {
	formatLoomCsvCell,
	isLoomCsvResultsFile,
	LOOM_CSV_RESULTS_HEADERS,
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

describe("Loom CSV delimiters", () => {
	it("reads semicolon separated files", () => {
		expect(
			parseLoomCsvRecords(
				"\uFEFFloom_video_url;user_email\r\n" +
					"https://www.loom.com/share/0123456789abcdef;owner@example.com\r\n",
			),
		).toEqual([
			["loom_video_url", "user_email"],
			["https://www.loom.com/share/0123456789abcdef", "owner@example.com"],
		]);
	});

	it("keeps quoted commas inside semicolon separated cells", () => {
		const rows = parseConciergeLoomCsv(
			"loom_video_url;user_email;space_name\n" +
				"https://www.loom.com/share/0123456789abcdef;owner@example.com;" +
				JSON.stringify("Sales, Europe") +
				"\n",
		);
		expect(rows[0]?.spaceName).toBe("Sales, Europe");
		expect(rows[0]?.userEmail).toBe("owner@example.com");
	});

	it("keeps comma files that have semicolons in their values", () => {
		expect(
			parseLoomCsvRecords(
				"url," +
					JSON.stringify("Folder; Archive") +
					",title\n" +
					"https://www.loom.com/share/0123456789abcdef,a;b;c,Demo; take 2\n",
			),
		).toEqual([
			["url", "Folder; Archive", "title"],
			["https://www.loom.com/share/0123456789abcdef", "a;b;c", "Demo; take 2"],
		]);
	});

	it("finds the delimiter after leading blank lines", () => {
		const rows = parseConciergeLoomCsv(
			"\r\n;;\n  \nloom_video_url;user_email\n" +
				"https://www.loom.com/share/0123456789abcdef;owner@example.com\n",
		);
		expect(rows).toEqual([
			{
				rowNumber: 2,
				loomUrl: "https://www.loom.com/share/0123456789abcdef",
				userEmail: "owner@example.com",
				spaceName: undefined,
			},
		]);
	});

	it("treats a single column file as comma separated", () => {
		expect(
			parseLoomCsvRecords("url\nhttps://www.loom.com/share/a;b\n"),
		).toEqual([["url"], ["https://www.loom.com/share/a;b"]]);
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
	it("restores every value when a results CSV is imported again", () => {
		const values = [
			"@Sales",
			"+owner@example.com",
			"-Ops, EU",
			"=1",
			"'@Sales",
			"''=1",
			"'Sales",
			"O'Brien",
			"Sales",
		];
		const [cells] = parseLoomCsvRecords(
			`${values.map(formatLoomCsvCell).join(",")}\n`,
		);
		expect(cells?.map(readLoomCsvCell)).toEqual(values);
	});

	it("leaves apostrophes alone when no formula character follows", () => {
		expect(readLoomCsvCell("'Sales")).toBe("'Sales");
		expect(readLoomCsvCell("O'Brien")).toBe("O'Brien");
	});

	it("recognizes the results CSV layout regardless of column order or case", () => {
		expect(isLoomCsvResultsFile([...LOOM_CSV_RESULTS_HEADERS])).toBe(true);
		expect(
			isLoomCsvResultsFile([
				"Status",
				"Error",
				"Row",
				"User_Email",
				"Space_Name",
				"Loom_Video_URL",
			]),
		).toBe(true);
		expect(
			isLoomCsvResultsFile(["loom_video_url", "user_email", "space_name"]),
		).toBe(false);
	});
});
