import { Video } from "@cap/web-domain";
import { Either, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { readCompletedRecordingManifest } from "@/lib/desktop-recording-verification";
import { getSegmentPlaybackState } from "@/lib/segment-playback";

const manifest = {
	version: 2,
	video_init_uploaded: true,
	audio_init_uploaded: true,
	video_segments: [{ index: 1, duration: 3 }],
	audio_segments: [{ index: 1, duration: 3 }],
	is_complete: true,
};

function serializedPlaybackState(
	value: Video.SegmentManifestType,
): "ready" | "uploading" | "incomplete" {
	if (!value.is_complete) return "uploading";
	try {
		readCompletedRecordingManifest(JSON.stringify(value));
		return "ready";
	} catch {
		return "incomplete";
	}
}

function segments(count: number) {
	return Array.from({ length: count }, (_, position) => ({
		index: position + 1,
		duration: 3.0001,
	}));
}

function completeManifest(count: number): Video.SegmentManifestType {
	return {
		version: 2,
		video_init_uploaded: true,
		audio_init_uploaded: true,
		video_segments: segments(count),
		audio_segments: segments(count),
		is_complete: true,
	};
}

function seededRandom(seed: number) {
	let state = seed >>> 0;
	return () => {
		state = (state * 1664525 + 1013904223) >>> 0;
		return state / 2 ** 32;
	};
}

function randomManifest(random: () => number): unknown {
	const pick = <T>(values: readonly T[]): T =>
		values[Math.floor(random() * values.length)] as T;
	const numbers = [0, -0, -1, 1, 2, 3, 1.5, 0.0001, 1e308, 2 ** 53, 2 ** 60];
	const entry = (position: number): unknown => {
		const index =
			random() < 0.85 ? position + 1 : pick([...numbers, position, "1"]);
		if (random() < 0.3) return index;
		const value: Record<string, unknown> = {
			index,
			duration: random() < 0.85 ? 0.5 + random() * 4 : pick(numbers),
		};
		if (random() < 0.1) value.extra = "field";
		return value;
	};
	const list = () => {
		const count = pick([0, 1, 2, 3, 5, 8]);
		const items = Array.from({ length: count }, (_, position) =>
			entry(position),
		);
		if (count > 1 && random() < 0.1) items.reverse();
		if (count > 0 && random() < 0.1) items.push(items[0]);
		return items;
	};
	const value: Record<string, unknown> = {
		version: random() < 0.85 ? pick([1, 2]) : pick([...numbers, "1"]),
		video_init_uploaded: random() < 0.85 ? true : pick([false, 1, "true"]),
		audio_init_uploaded: random() < 0.5,
		video_segments: list(),
		audio_segments: list(),
		is_complete: random() < 0.9 ? true : pick([false, 1]),
	};
	if (random() < 0.1) value.extra = { nested: true };
	return value;
}

const decodeManifest = Schema.decodeUnknownEither(Video.SegmentManifest);

const edgeCases: Video.SegmentManifestType[] = [
	completeManifest(1),
	completeManifest(3),
	{ ...completeManifest(3), audio_init_uploaded: false, audio_segments: [] },
	{ ...completeManifest(3), audio_init_uploaded: false },
	{ ...completeManifest(3), audio_segments: [] },
	{ ...completeManifest(3), video_init_uploaded: false },
	{ ...completeManifest(3), is_complete: false },
	{ ...completeManifest(3), video_segments: [] },
	{ ...completeManifest(3), version: 0 },
	{ ...completeManifest(3), version: 1.5 },
	{ ...completeManifest(3), version: -1 },
	{ ...completeManifest(3), version: Number.NaN },
	{ ...completeManifest(3), version: Number.POSITIVE_INFINITY },
	{ ...completeManifest(3), version: 2 ** 60 },
	{
		...completeManifest(3),
		video_segments: [
			{ index: 1, duration: 3 },
			{ index: 3, duration: 3 },
		],
	},
	{
		...completeManifest(3),
		video_segments: [
			{ index: 2, duration: 3 },
			{ index: 1, duration: 3 },
		],
	},
	{
		...completeManifest(3),
		audio_segments: [
			{ index: 1, duration: 3 },
			{ index: 1, duration: 3 },
		],
	},
	{ ...completeManifest(3), video_segments: [{ index: 0, duration: 3 }] },
	{ ...completeManifest(3), video_segments: [{ index: 1.5, duration: 3 }] },
	{ ...completeManifest(3), video_segments: [{ index: 1, duration: 0 }] },
	{ ...completeManifest(3), video_segments: [{ index: 1, duration: -0 }] },
	{ ...completeManifest(3), video_segments: [{ index: 1, duration: -2 }] },
	{
		...completeManifest(3),
		video_segments: [{ index: 1, duration: Number.NaN }],
	},
	{
		...completeManifest(3),
		video_segments: [{ index: 1, duration: Number.POSITIVE_INFINITY }],
	},
	{ ...completeManifest(3), video_segments: [Number.NaN] },
	{ ...completeManifest(3), video_segments: [Number.POSITIVE_INFINITY] },
	{ ...completeManifest(3), video_segments: [1, 2, 3], audio_segments: [1] },
	{ ...completeManifest(3), video_segments: [1, 2, 2] },
	{ ...completeManifest(3), video_segments: [0, 1] },
	{ ...completeManifest(3), video_segments: [1, { index: 2, duration: 3 }] },
	{
		...completeManifest(3),
		video_segments: [
			{ index: 1, duration: 3, extra: true } as {
				index: number;
				duration: number;
			},
		],
	},
	{
		...completeManifest(3),
		extra: "field",
	} as Video.SegmentManifestType,
	{
		...completeManifest(3),
		video_segments: [{ index: "1", duration: 3 }],
	} as unknown as Video.SegmentManifestType,
	{
		...completeManifest(3),
		video_segments: [{ index: 1, duration: "3" }],
	} as unknown as Video.SegmentManifestType,
	{
		...completeManifest(3),
		video_segments: ["1"],
	} as unknown as Video.SegmentManifestType,
	{
		...completeManifest(3),
		video_segments: [null],
	} as unknown as Video.SegmentManifestType,
	{
		...completeManifest(3),
		video_segments: [{ duration: 3 }],
	} as unknown as Video.SegmentManifestType,
	{
		...completeManifest(3),
		version: "2",
	} as unknown as Video.SegmentManifestType,
	{
		...completeManifest(3),
		audio_init_uploaded: "true",
	} as unknown as Video.SegmentManifestType,
	{
		...completeManifest(3),
		video_init_uploaded: 1,
	} as unknown as Video.SegmentManifestType,
	{
		...completeManifest(3),
		audio_segments: null,
	} as unknown as Video.SegmentManifestType,
	{
		...completeManifest(3),
		video_segments: {},
	} as unknown as Video.SegmentManifestType,
];

describe("Instant recording playback readiness", () => {
	it("allows complete audio and video without waiting for an MP4", () => {
		expect(getSegmentPlaybackState(manifest)).toBe("ready");
	});

	it("allows an intentionally silent recording", () => {
		expect(
			getSegmentPlaybackState({
				...manifest,
				audio_init_uploaded: false,
				audio_segments: [],
			}),
		).toBe("ready");
	});

	it("keeps unfinished uploads pending even when their first frame exists", () => {
		expect(getSegmentPlaybackState({ ...manifest, is_complete: false })).toBe(
			"uploading",
		);
	});

	it.each([
		{ audio_init_uploaded: false },
		{ video_segments: [{ index: 4, duration: 1.589 }] },
		{
			video_init_uploaded: false,
			audio_init_uploaded: false,
			video_segments: [],
			audio_segments: [],
		},
		{
			video_segments: [
				{ index: 1, duration: 2.09 },
				{ index: 2, duration: 0.662 },
			],
			audio_init_uploaded: false,
		},
		{ audio_segments: [] },
		{ video_segments: [{ index: 1, duration: 0 }] },
	])(
		"refuses an incomplete source instead of silently dropping media: %j",
		(change) => {
			expect(getSegmentPlaybackState({ ...manifest, ...change })).toBe(
				"incomplete",
			);
		},
	);

	it("retains support for legacy numeric segment entries", () => {
		expect(
			getSegmentPlaybackState({
				...manifest,
				version: 1,
				video_segments: [1, 2],
				audio_segments: [1, 2],
			}),
		).toBe("ready");
	});

	it("matches the serialized manifest check on edge cases", () => {
		const states = new Set<string>();
		for (const value of edgeCases) {
			const expected = serializedPlaybackState(value);
			states.add(expected);
			expect(getSegmentPlaybackState(value), JSON.stringify(value)).toBe(
				expected,
			);
		}
		expect(states).toEqual(new Set(["ready", "uploading", "incomplete"]));
	});

	it("matches the serialized manifest check on decoded random manifests", () => {
		const random = seededRandom(0x5eed);
		const counts = { ready: 0, uploading: 0, incomplete: 0, undecodable: 0 };
		for (let iteration = 0; iteration < 20_000; iteration++) {
			const raw = randomManifest(random);
			const decoded = decodeManifest(JSON.parse(JSON.stringify(raw)));
			const candidates: unknown[] = [raw];
			if (Either.isRight(decoded)) candidates.push(decoded.right);
			else counts.undecodable++;
			for (const candidate of candidates) {
				const value = candidate as Video.SegmentManifestType;
				const expected = serializedPlaybackState(value);
				counts[expected]++;
				expect(getSegmentPlaybackState(value), JSON.stringify(value)).toBe(
					expected,
				);
			}
		}
		expect(counts.ready).toBeGreaterThan(500);
		expect(counts.incomplete).toBeGreaterThan(500);
		expect(counts.uploading).toBeGreaterThan(500);
		expect(counts.undecodable).toBeGreaterThan(500);
	});

	it.skipIf(!process.env.CAP_BENCH_SEGMENT_PLAYBACK)(
		"measures readiness checks for long recordings",
		() => {
			const time = (check: () => unknown) => {
				for (let iteration = 0; iteration < 200; iteration++) check();
				const start = performance.now();
				for (let iteration = 0; iteration < 500; iteration++) check();
				return (performance.now() - start) / 500;
			};
			for (const count of [100, 1200, 3600]) {
				const value = completeManifest(count);
				expect(getSegmentPlaybackState(value)).toBe("ready");
				expect(serializedPlaybackState(value)).toBe("ready");
				const serialized: number[] = [];
				const direct: number[] = [];
				for (let round = 0; round < 7; round++) {
					serialized.push(time(() => serializedPlaybackState(value)));
					direct.push(time(() => getSegmentPlaybackState(value)));
				}
				serialized.sort((a, b) => a - b);
				direct.sort((a, b) => a - b);
				console.log(
					JSON.stringify({
						count,
						serializedMedianMs: serialized[3],
						serializedRangeMs: [serialized[0], serialized[6]],
						directMedianMs: direct[3],
						directRangeMs: [direct[0], direct[6]],
					}),
				);
			}
		},
		120_000,
	);
});
