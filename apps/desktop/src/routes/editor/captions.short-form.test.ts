import { describe, expect, it } from "vitest";

import { segmentCaptionsForShortForm } from "./short-form-captions";

describe("segmentCaptionsForShortForm", () => {
	it("creates short Chinese phrases at the configured character limit", () => {
		const words = "这是一个中文短视频字幕示例".split("").map((text, index) => ({
			text,
			start: index * 0.1,
			end: (index + 1) * 0.1,
		}));

		const result = segmentCaptionsForShortForm([
			{
				id: "zh",
				start: 0,
				end: 1.2,
				text: words.map((word) => word.text).join(""),
				words,
			},
		]);

		expect(result.map((segment) => segment.text)).toEqual([
			"这是一个中文短视",
			"频字幕示例",
		]);
		expect(result[0]?.end).toBeCloseTo(0.8);
		expect(result[1]?.start).toBeCloseTo(0.8);
	});

	it("prefers a meaningful pause once a phrase is long enough", () => {
		const result = segmentCaptionsForShortForm([
			{
				id: "pause",
				start: 0,
				end: 1.1,
				text: "这个功能现在可以录屏了",
				words: [
					{ text: "这个", start: 0, end: 0.1 },
					{ text: "功能", start: 0.1, end: 0.2 },
					{ text: "现在", start: 0.2, end: 0.3 },
					{ text: "可以", start: 0.55, end: 0.65 },
					{ text: "录屏", start: 0.65, end: 0.75 },
					{ text: "了", start: 0.75, end: 0.85 },
				],
			},
		]);

		expect(result.map((segment) => segment.text)).toEqual([
			"这个功能现在",
			"可以录屏了",
		]);
	});

	it("keeps English words readable and starts a new phrase after four words", () => {
		const words = ["Build", "better", "product", "demos", "today"].map(
			(text, index) => ({
				text,
				start: index * 0.2,
				end: (index + 1) * 0.2,
			}),
		);

		const result = segmentCaptionsForShortForm([
			{
				id: "en",
				start: 0,
				end: 1,
				text: "Build better product demos today",
				words,
			},
		]);

		expect(result.map((segment) => segment.text)).toEqual([
			"Build better product demos",
			"today",
		]);
	});

	it("preserves segments without word timing", () => {
		const source = {
			id: "legacy",
			start: 1,
			end: 2,
			text: "legacy caption",
			words: [],
		};

		expect(segmentCaptionsForShortForm([source])).toEqual([source]);
	});
});
