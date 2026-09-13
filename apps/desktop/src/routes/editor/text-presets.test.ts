import { describe, expect, it } from "vitest";
import { defaultTextSegment } from "./text";
import {
	applyTextPreset,
	matchTextPreset,
	TEXT_PRESET_GROUPS,
	TEXT_PRESETS,
} from "./text-presets";

const INSTALLED = ["Helvetica Neue", "Georgia", "Menlo"];

describe("text presets", () => {
	it("every preset belongs to a listed group and ends its stack in a generic", () => {
		for (const preset of TEXT_PRESETS) {
			expect(TEXT_PRESET_GROUPS).toContain(preset.group);
			expect(["sans-serif", "serif", "monospace"]).toContain(
				preset.style.fontStack.at(-1),
			);
		}
		expect(TEXT_PRESETS.map((preset) => preset.id)).toHaveLength(
			new Set(TEXT_PRESETS.map((preset) => preset.id)).size,
		);
	});

	it("applying a preset is recognised as that preset", () => {
		for (const preset of TEXT_PRESETS) {
			const segment = defaultTextSegment(0, 2);
			applyTextPreset(segment, preset, INSTALLED);
			expect(matchTextPreset(segment, INSTALLED)).toBe(preset.id);
		}
	});

	it("adopts the sample only while the content is untouched", () => {
		const fresh = defaultTextSegment(0, 2);
		applyTextPreset(fresh, TEXT_PRESETS[0], INSTALLED);
		expect(fresh.content).toBe(TEXT_PRESETS[0].sample);

		const written = defaultTextSegment(0, 2);
		written.content = "Hello there";
		applyTextPreset(written, TEXT_PRESETS[0], INSTALLED);
		expect(written.content).toBe("Hello there");
	});

	it("keeps the segment colour unless the preset sets one and clears leftover looks", () => {
		const segment = defaultTextSegment(0, 2);
		segment.color = "#123456";
		const sticker = TEXT_PRESETS.find((preset) => preset.id === "sticker");
		const title = TEXT_PRESETS.find((preset) => preset.id === "title");
		if (!sticker || !title) throw new Error("presets missing");

		applyTextPreset(segment, sticker, INSTALLED);
		expect(segment.color).toBe("#ffffff");
		expect(segment.strokeWidth).toBe(8);

		segment.color = "#123456";
		applyTextPreset(segment, title, INSTALLED);
		expect(segment.color).toBe("#123456");
		expect(segment.strokeWidth).toBe(0);
		expect(segment.backgroundColor).toBeNull();
		expect(segment.gradientColor).toBeNull();
		expect(segment.glow).toBe(0);
	});

	it("scales the box about its top edge and moves it only for placed presets", () => {
		const segment = defaultTextSegment(0, 2);
		const topEdge = segment.center.y - segment.size.y / 2;
		const title = TEXT_PRESETS.find((preset) => preset.id === "title");
		const lowerThird = TEXT_PRESETS.find(
			(preset) => preset.id === "lower-third",
		);
		if (!title || !lowerThird) throw new Error("presets missing");

		applyTextPreset(segment, title, INSTALLED);
		expect(segment.center.x).toBe(0.5);
		expect(segment.center.y - segment.size.y / 2).toBeCloseTo(topEdge, 6);

		applyTextPreset(segment, lowerThird, INSTALLED);
		expect(segment.center).toEqual(lowerThird.center);
	});
});
