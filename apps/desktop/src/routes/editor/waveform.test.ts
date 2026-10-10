import { describe, expect, it } from "vitest";
import type { AspectRatio, BackgroundSource } from "~/utils/tauri";
import {
	applyAudioOnlySetup,
	defaultWaveformSegment,
	needsAudioOnlySetup,
	placeWaveform,
	waveformGapAt,
	waveformPlacementActive,
} from "./waveform";

const plainProject = () => ({
	hideDisplay: false,
	aspectRatio: null as AspectRatio | null,
	background: {
		source: { type: "color", value: [255, 255, 255] } as BackgroundSource,
	},
	timeline: { waveformSegments: [] },
});

describe("waveform placement", () => {
	it("fills the free stretch of a lane around the requested time", () => {
		expect(waveformGapAt([], 3, 20)).toEqual({ start: 0, end: 20 });
		expect(
			waveformGapAt(
				[
					{ start: 0, end: 4 },
					{ start: 12, end: 20 },
				],
				6,
				20,
			),
		).toEqual({ start: 4, end: 12 });
		expect(waveformGapAt([{ start: 0, end: 20 }], 6, 20)).toBeNull();
	});

	it("keeps the size when snapping to a preset and reports the active one", () => {
		const segment = defaultWaveformSegment(0, 10, 0);
		const bottom = placeWaveform(segment, "bottom");
		expect(bottom.size).toEqual(segment.size);
		expect(bottom.center.y + bottom.size.y / 2).toBeLessThan(1);
		expect(waveformPlacementActive({ ...segment, ...bottom }, "bottom")).toBe(
			true,
		);
		expect(waveformPlacementActive({ ...segment, ...bottom }, "top")).toBe(
			false,
		);
		const wide = placeWaveform(segment, "fullWidth");
		expect(wide.size.x).toBe(1);
		expect(wide.center.y).toBe(segment.center.y);
	});
});

describe("audio-only setup", () => {
	it("hides the screen and adds one centred waveform over the whole recording", () => {
		const project = plainProject();
		expect(needsAudioOnlySetup(project)).toBe(true);
		applyAudioOnlySetup(project, 42);
		expect(project.hideDisplay).toBe(true);
		expect(project.aspectRatio).toBe("wide");
		expect(project.background.source.type).toBe("gradient");
		expect(project.timeline.waveformSegments).toMatchObject([
			{ start: 0, end: 42, style: "mirrored", center: { x: 0.5, y: 0.5 } },
		]);
		expect(needsAudioOnlySetup(project)).toBe(false);
	});

	it("leaves an edited project and a chosen background alone", () => {
		const project = plainProject();
		project.background.source = { type: "wallpaper", path: "dark/1" };
		applyAudioOnlySetup(project, 10);
		expect(project.background.source.type).toBe("wallpaper");
		expect(
			needsAudioOnlySetup({
				...plainProject(),
				timeline: { waveformSegments: [defaultWaveformSegment(0, 1, 0)] },
			}),
		).toBe(false);
	});
});
