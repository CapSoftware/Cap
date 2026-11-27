import { describe, expect, it } from "vitest";
import {
	NOTE_EXCERPT_CHARS,
	NOTE_TITLE_COLUMN_CHARS,
	noteExcerpt,
	noteTitle,
} from "@/lib/meetings/share-content";

describe("note title", () => {
	it("keeps a title as written, on one line", () => {
		expect(noteTitle("  Weekly\n sync  ")).toBe("Weekly sync");
	});

	it("names a note that has no title", () => {
		expect(noteTitle(" \n ")).toBe("Untitled note");
	});

	it("fits the title column without splitting a character", () => {
		const title = noteTitle("🎥".repeat(300));

		expect(Array.from(title)).toHaveLength(NOTE_TITLE_COLUMN_CHARS);
		expect(title.endsWith("🎥")).toBe(true);
	});
});

describe("note excerpt", () => {
	it("reads as plain text", () => {
		const markdown = [
			"## Summary",
			"",
			"We ship **export** on _Monday_.",
			"",
			"---",
			"- [ ] Email the [list](https://example.com/list)",
			"- [x] Fix `scrub` bug",
			"1. Call Juno",
			"> Agreed by all",
			"![chart](https://example.com/chart.png)",
		].join("\n");

		expect(noteExcerpt(markdown)).toBe(
			"We ship export on Monday. Email the list Fix scrub bug Call Juno Agreed by all chart",
		);
	});

	it("leaves out code blocks and markup", () => {
		expect(
			noteExcerpt(
				'Before\n```ts\nconst key = "value";\n```\nAfter <script>alert(1)</script><b>bold</b>',
			),
		).toBe("Before After alert(1)bold");
	});

	it("is empty for a note with only headings", () => {
		expect(noteExcerpt("# Title\n\n## Section")).toBe("");
	});

	it("stops at the card length without splitting a character", () => {
		const excerpt = noteExcerpt("🙂".repeat(500));

		expect(Array.from(excerpt)).toHaveLength(NOTE_EXCERPT_CHARS);
	});
});
