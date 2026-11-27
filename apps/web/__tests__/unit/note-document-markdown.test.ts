import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NoteDocument } from "@/app/s/[videoId]/_components/note/NoteDocument";

const render = (summaryMarkdown: string, notesMarkdown: string | null = null) =>
	renderToStaticMarkup(
		createElement(NoteDocument, {
			summaryMarkdown,
			notesMarkdown,
			participants: ["<img src=x onerror=alert(1)>"],
			meetingStartedAt: null,
			duration: 120,
			ownerName: "<script>alert(1)</script>",
		}),
	);

describe("shared note markdown", () => {
	it("shows markup in a note as text, never as elements", () => {
		const html = render(
			[
				"<script>alert(1)</script>",
				'<img src="https://example.com/p.png" onerror="alert(1)">',
				'<iframe src="https://example.com"></iframe>',
				'<a href="javascript:alert(1)" onclick="alert(1)">raw</a>',
				"<style>body{display:none}</style>",
			].join("\n\n"),
			"<svg onload=alert(1)></svg>",
		);

		expect(html).not.toMatch(/<(script|img|iframe|style|svg)\b/i);
		expect(html.replace(/"[^"]*"/g, '""')).not.toMatch(
			/<[a-z][^>]*\son[a-z]+=/i,
		);
		expect(html).not.toMatch(/<a\b/i);
		expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
	});

	it("drops images and unsafe link targets written in markdown", () => {
		const html = render(
			[
				"![pixel](https://example.com/track.png)",
				"[run](javascript:alert(1))",
				"[data](data:text/html;base64,PHNjcmlwdD4=)",
				"[vb](vbscript:msgbox(1))",
				"[site](https://example.com/page)",
			].join("\n\n"),
		);

		expect(html).not.toMatch(/<img\b/i);
		expect(html).not.toMatch(/href="(javascript|data|vbscript):/i);
		expect(html).toContain(
			'href="https://example.com/page" target="_blank" rel="noopener noreferrer nofollow"',
		);
	});

	it("renders task lists without form controls", () => {
		const html = render("- [x] Done\n- [ ] Next");

		expect(html).not.toMatch(/<input\b/i);
		expect(html).toContain('aria-label="Done"');
		expect(html).toContain('aria-label="To do"');
	});
});
