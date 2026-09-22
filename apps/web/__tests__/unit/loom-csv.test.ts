import { describe, expect, it } from "vitest";
import { parseConciergeLoomCsv } from "@/lib/loom-csv";

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
