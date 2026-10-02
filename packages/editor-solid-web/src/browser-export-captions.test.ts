import { expect, test } from "bun:test";
import { exportCaptionSettings } from "./browser-export-captions";

const config = (enabled: boolean, exportWithSubtitles: boolean) => ({
	captions: {
		segments: [{ id: "segment-0", start: 0, end: 1, text: "Hello" }],
		settings: { enabled, exportWithSubtitles, font: "Geist" },
	},
	timeline: { captionSegments: [{ id: "segment-0", start: 0, end: 1 }] },
});

test("captions reach an export only with Export with Subtitles on", () => {
	for (const [enabled, exportWithSubtitles, exported] of [
		[true, true, true],
		[true, false, false],
		[false, true, false],
		[false, false, false],
	] as const) {
		const input = config(enabled, exportWithSubtitles);
		const output = exportCaptionSettings(input);
		expect(output.captions).toEqual({
			...input.captions,
			settings: { ...input.captions.settings, enabled: exported },
		});
		expect(output.timeline).toBe(input.timeline);
		expect(input.captions.settings.enabled).toBe(enabled);
	}
});

test("projects without caption settings export unchanged", () => {
	const project = { timeline: { segments: [] } };
	expect(exportCaptionSettings(project)).toBe(project);
	const noSettings = { captions: { segments: [] } };
	expect(exportCaptionSettings(noSettings)).toBe(noSettings);
});
