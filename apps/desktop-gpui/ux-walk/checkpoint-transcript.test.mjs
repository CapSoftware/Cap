import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { durableJson, sha256 } from "./checkpoint-store.mjs";
import { reuseCheckpointTranscript } from "./checkpoint-transcript.mjs";

test("final transcript reuses source-qualified jobs with display spans, offsets and partial coverage", async (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "uxw-cache-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	fs.mkdirSync(path.join(root, "checkpoints/jobs"), { recursive: true });
	durableJson(path.join(root, "checkpoints/final-layout.json"), {
		displaySpans: [10, 8],
		meta: {
			segments: [
				{ display: { start_time: 0 }, mic: { start_time: 0 } },
				{ display: { start_time: 1 }, mic: { start_time: 0 } },
			],
		},
		config: { clips: [{ index: 1, offsets: { mic: 1 } }] },
	});
	const result = {
		source: "segment-1:microphone",
		sourceStartMs: 0,
		sourceEndMs: 4000,
		words: [{ start: 1.5, end: 2, text: "retained", speaker: "chunk-local-0" }],
	};
	const id = "a".repeat(64);
	const resultFile = path.join(root, `checkpoints/jobs/${id}.words.json`);
	durableJson(resultFile, result);
	durableJson(path.join(root, `checkpoints/jobs/${id}.json`), {
		jobId: id,
		source: result.source,
		sourceStartMs: 0,
		sourceEndMs: 4000,
		state: "complete",
		resultHash: sha256(fs.readFileSync(resultFile)),
	});
	const rows = [{ dir: "chapter", startMs: 9000, endMs: 13000 }];
	fs.mkdirSync(path.join(root, "chapter"));
	const reused = await reuseCheckpointTranscript(root, rows, 0);
	assert.equal(reused.handled, true);
	assert.match(reused.results.get("chapter").transcriptError, /partial/i);
	const srt = fs.readFileSync(
		path.join(root, "chapter/transcript.srt"),
		"utf8",
	);
	assert.match(srt, /00:00:01,500 --> 00:00:02,000/);
	assert.match(srt, /retained/);
	assert.equal(JSON.parse(fs.readFileSync(resultFile)).words[0].start, 1.5);
});

test("a live checkpoint owner with no prepared jobs cannot race a duplicate batch submission", async (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "uxw-pending-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	fs.mkdirSync(path.join(root, "checkpoints/jobs"), { recursive: true });
	durableJson(path.join(root, "checkpoints/identity.json"), {
		generation: "owned",
	});
	fs.mkdirSync(path.join(root, "chapter"));
	const reused = await reuseCheckpointTranscript(
		root,
		[{ dir: "chapter", startMs: 0, endMs: 1000 }],
		0,
		{ transcriber: "elevenlabs" },
	);
	assert.equal(reused.handled, true);
	assert.match(
		reused.results.get("chapter").transcriptError,
		/pending|draining/i,
	);
});

test("a verified terminal capture with intentionally disabled audio is unavailable without errors, while missing intent and active ownership stay pending", async (t) => {
	for (const variant of [
		"intentional",
		"expected-mic",
		"unknown-intent",
		"unsealed",
		"changed-layout",
		"active-owner",
		"ambiguous-job",
	]) {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "uxw-no-audio-"));
		t.after(() => fs.rmSync(root, { recursive: true, force: true }));
		const checkpoint = path.join(root, "checkpoints");
		fs.mkdirSync(path.join(checkpoint, "jobs"), { recursive: true });
		fs.mkdirSync(path.join(checkpoint, "descriptors"));
		fs.mkdirSync(path.join(root, "chapter"));
		const identity = { recordingId: "synthetic", generation: "one" };
		durableJson(path.join(checkpoint, "identity.json"), identity);
		const layout = path.join(checkpoint, "final-layout.json");
		durableJson(layout, {
			displaySpans: [1],
			meta: {
				status: { status: "Complete" },
				segments: [{ display: { path: "display.mp4", start_time: 0 } }],
			},
			config: {},
			sourceDurations: {},
		});
		const descriptor = path.join(checkpoint, "descriptors/000000000001.json");
		durableJson(descriptor, {
			sequence: 1,
			captureState: "complete",
			finalized: true,
			objects: [],
		});
		if (variant !== "unsealed")
			durableJson(path.join(checkpoint, "seal.json"), {
				schemaVersion: 1,
				...identity,
				sequence: 1,
				descriptorHash: sha256(fs.readFileSync(descriptor)),
				captureState: "complete",
				providerJobs: 0,
				unsupportedSources: {},
				sourceCaptureState: "Complete",
				expectedAudio:
					variant === "unknown-intent"
						? {}
						: { microphone: variant === "expected-mic", systemAudio: false },
				finalLayoutHash: sha256(fs.readFileSync(layout)),
			});
		if (variant === "changed-layout") fs.appendFileSync(layout, " ");
		if (variant === "active-owner") {
			fs.mkdirSync(path.join(root, ".checkpoint-worker"));
			durableJson(path.join(root, ".checkpoint-worker/owner.json"), {
				pid: process.pid,
			});
		}
		if (variant === "ambiguous-job")
			durableJson(path.join(checkpoint, `jobs/${"f".repeat(64)}.json`), {
				jobId: "f".repeat(64),
				state: "ambiguous",
				source: "segment-0:microphone",
				sourceStartMs: 0,
				sourceEndMs: 1000,
			});
		const reused = await reuseCheckpointTranscript(
			root,
			[{ dir: "chapter", startMs: 0, endMs: 1000 }],
			0,
			{ transcriber: "elevenlabs", liveTranscription: true },
		);
		assert.equal(reused.handled, true, variant);
		assert.equal(reused.results.get("chapter").transcript, false, variant);
		if (variant === "intentional") assert.equal(reused.error, null, variant);
		else assert.ok(reused.error, variant);
	}
});

test("unsupported channel, calibration and edited timeline layouts never claim aligned live captions", async (t) => {
	for (const config of [
		{ audio: { micStereoMode: "monoL" } },
		{ timeline: { transitions: [{ duration: 1 }] } },
		{ timeline: { audioSegments: [{ enabled: true }] } },
		{
			timeline: {
				textSegments: [
					{ enabled: true, layout: "fullscreen", start: 0, end: 1 },
				],
			},
		},
	]) {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "uxw-layout-"));
		t.after(() => fs.rmSync(root, { recursive: true, force: true }));
		fs.mkdirSync(path.join(root, "checkpoints/jobs"), { recursive: true });
		fs.mkdirSync(path.join(root, "chapter"));
		const id = "c".repeat(64),
			file = path.join(root, `checkpoints/jobs/${id}.words.json`);
		durableJson(file, {
			source: "segment-0:microphone",
			words: [{ start: 0, end: 1, text: "raw speech" }],
		});
		durableJson(path.join(root, `checkpoints/jobs/${id}.json`), {
			jobId: id,
			source: "segment-0:microphone",
			sourceStartMs: 0,
			sourceEndMs: 1000,
			state: "complete",
			resultHash: sha256(fs.readFileSync(file)),
		});
		durableJson(path.join(root, "checkpoints/final-layout.json"), {
			displaySpans: [1],
			meta: {
				segments: [{ display: { start_time: 0 }, mic: { start_time: 0 } }],
			},
			config,
		});
		const reused = await reuseCheckpointTranscript(
			root,
			[{ dir: "chapter", startMs: 0, endMs: 1000 }],
			0,
		);
		assert.match(
			reused.error,
			/unsupported|edited|alignment/i,
			JSON.stringify(config),
		);
	}
});

test("unsupported alignment archives previously generated captions instead of reusing stale final times", async (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "uxw-stale-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	fs.mkdirSync(path.join(root, "checkpoints/jobs"), { recursive: true });
	fs.mkdirSync(path.join(root, "chapter"));
	const id = "d".repeat(64),
		file = path.join(root, `checkpoints/jobs/${id}.words.json`);
	durableJson(file, {
		source: "segment-0:microphone",
		words: [{ start: 0, end: 1, text: "saved speech" }],
	});
	durableJson(path.join(root, `checkpoints/jobs/${id}.json`), {
		jobId: id,
		source: "segment-0:microphone",
		sourceStartMs: 0,
		sourceEndMs: 1000,
		state: "complete",
		resultHash: sha256(fs.readFileSync(file)),
	});
	const layout = {
		displaySpans: [1],
		meta: {
			segments: [{ display: { start_time: 0 }, mic: { start_time: 0 } }],
		},
		config: {},
	};
	const layoutFile = path.join(root, "checkpoints/final-layout.json");
	durableJson(layoutFile, layout);
	const rows = [{ dir: "chapter", startMs: 0, endMs: 1000 }];
	await reuseCheckpointTranscript(root, rows, 0);
	assert.ok(fs.existsSync(path.join(root, "chapter/transcript.srt")));
	durableJson(layoutFile, {
		...layout,
		alignmentProblem: "Calibration offsets require rendered-audio alignment",
	});
	const reused = await reuseCheckpointTranscript(root, rows, 0);
	assert.match(reused.error, /alignment/i);
	assert.equal(fs.existsSync(path.join(root, "chapter/transcript.srt")), false);
	assert.ok(
		fs
			.readdirSync(path.join(root, "chapter"))
			.some(
				(name) =>
					name.startsWith("transcript-source-") && name.endsWith(".srt"),
			),
	);
});

function chunkedWalk(t, jobs, displaySpan = 1000, segment = {}, segments = 1) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "uxw-speakers-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	fs.mkdirSync(path.join(root, "checkpoints/jobs"), { recursive: true });
	fs.mkdirSync(path.join(root, "chapter"));
	durableJson(path.join(root, "checkpoints/final-layout.json"), {
		displaySpans: Array(segments).fill(displaySpan),
		meta: {
			segments: Array(segments).fill({
				display: { start_time: 0 },
				mic: { start_time: 0 },
				...segment,
			}),
		},
		config: {},
	});
	for (const job of jobs) {
		const id = job.fill.repeat(64);
		const source = job.source ?? "segment-0:microphone";
		const words = job.words.map((word) =>
			typeof word === "number"
				? { start: word, end: word + 0.3, speaker: job.speaker }
				: { end: word.start + 0.3, ...word },
		);
		const file = path.join(root, `checkpoints/jobs/${id}.words.json`);
		durableJson(file, {
			source,
			words: words.map((word, index) => ({
				text: `word${index}`,
				...word,
				start: word.start + job.startMs / 1000,
				end: word.end + job.startMs / 1000,
			})),
		});
		durableJson(path.join(root, `checkpoints/jobs/${id}.json`), {
			jobId: id,
			source,
			sourceStartMs: job.startMs,
			sourceEndMs: job.endMs,
			state: "complete",
			resultHash: sha256(fs.readFileSync(file)),
		});
	}
	return {
		root,
		srt: () =>
			fs.readFileSync(path.join(root, "chapter/transcript.srt"), "utf8"),
		sources: () =>
			JSON.parse(
				fs.readFileSync(path.join(root, "chapter/transcript-sources.json")),
			),
		labels() {
			return [...new Set(this.srt().match(/Speaker \d+(?=:)/g))];
		},
		reuse: (speakers, endMs = segments * displaySpan * 1000) =>
			reuseCheckpointTranscript(
				root,
				[{ dir: "chapter", startMs: 0, endMs }],
				0,
				{},
				speakers,
			),
	};
}

test("one configured speaker on one microphone keeps one name across every chunk of the walk's layout", async (t) => {
	const layout = JSON.parse(
		fs.readFileSync(
			new URL("./fixtures/one-voice-per-chunk.json", import.meta.url),
		),
	);
	const walk = chunkedWalk(t, layout.jobs, layout.displaySpan);
	const result = await walk.reuse(["Walker"]);
	const row = result.results.get("chapter");
	assert.deepEqual(row.speakers, ["Walker"]);
	assert.equal(row.speakerAttributionNotice, undefined);
	assert.deepEqual(walk.labels(), ["Speaker 1"]);

	const { parseSrt } = await import(
		new URL("../../../vendor/ux-walk/src/timeline.mjs", import.meta.url)
	);
	const cues = parseSrt(walk.srt(), [], row.speakers);
	assert.ok(cues.some((cue) => cue.start >= 900));
	assert.deepEqual([...new Set(cues.map((cue) => cue.speaker))], ["Walker"]);

	const saved = walk.sources();
	assert.match(saved.speakerIdentity, /every label here is Walker/);
	assert.equal(
		new Set(saved.words.map((word) => word.speaker)).size,
		4,
		"raw per-chunk labels stay as provenance",
	);
});

test("without an unambiguous single speaker the labels stay per chunk and the report says so", async (t) => {
	const twoChunks = (extra = {}) => [
		{
			fill: "a",
			startMs: 0,
			endMs: 300000,
			speaker: "a:speaker_0",
			words: [1, 2, 3],
		},
		{
			fill: "b",
			startMs: 300000,
			endMs: 600000,
			speaker: "b:speaker_0",
			words: [1, 2, 3],
			...extra,
		},
	];
	const expectUnmatched = async (walk, speakers, labels) => {
		const row = (await walk.reuse(speakers)).results.get("chapter");
		assert.deepEqual(row.speakers, []);
		assert.match(row.speakerAttributionNotice, /can be the same person/);
		assert.equal(walk.labels().length, labels);
		assert.match(walk.sources().speakerIdentity, /not matched across/);
	};

	await expectUnmatched(chunkedWalk(t, twoChunks()), ["Ann", "Bo"], 2);
	await expectUnmatched(chunkedWalk(t, twoChunks()), [], 2);
	await expectUnmatched(
		chunkedWalk(
			t,
			[
				...twoChunks(),
				{
					fill: "c",
					source: "segment-0:systemAudio",
					startMs: 0,
					endMs: 300000,
					speaker: "c:speaker_0",
					words: [5],
				},
			],
			1000,
			{ system_audio: { start_time: 0 } },
		),
		["Ann"],
		3,
	);
	await expectUnmatched(
		chunkedWalk(
			t,
			twoChunks({
				words: [
					{ start: 1, speaker: "b:speaker_0" },
					{ start: 2, speaker: "b:speaker_1" },
					{ start: 3, speaker: "b:speaker_1" },
				],
			}),
		),
		["Ann"],
		3,
	);
});

test("a stray voice or a paused segment still names the one configured speaker, and one chunk needs no notice", async (t) => {
	const busy = Array.from({ length: 99 }, (_, index) => index + 1);
	const stray = chunkedWalk(t, [
		{
			fill: "a",
			startMs: 0,
			endMs: 200000,
			words: [
				...busy.map((start) => ({ start, speaker: "a:speaker_0" })),
				{ start: 150, speaker: "a:speaker_1" },
			],
		},
	]);
	assert.deepEqual(
		(await stray.reuse(["Ann"])).results.get("chapter").speakers,
		["Ann"],
	);
	assert.deepEqual(stray.labels(), ["Speaker 1"]);

	const paused = chunkedWalk(
		t,
		[
			{
				fill: "c",
				startMs: 0,
				endMs: 5000,
				speaker: "c:speaker_0",
				words: [1],
			},
			{
				fill: "d",
				source: "segment-1:microphone",
				startMs: 0,
				endMs: 5000,
				speaker: "d:speaker_0",
				words: [1],
			},
		],
		5,
		{},
		2,
	);
	assert.deepEqual(
		(await paused.reuse(["Ann"])).results.get("chapter").speakers,
		["Ann"],
	);
	assert.deepEqual(paused.labels(), ["Speaker 1"]);

	const single = chunkedWalk(t, [
		{
			fill: "b",
			startMs: 0,
			endMs: 1000,
			speaker: "b:speaker_0",
			words: [0.1],
		},
	]);
	const row = (await single.reuse(["Ann", "Bo"])).results.get("chapter");
	assert.deepEqual(row.speakers, []);
	assert.equal(row.speakerAttributionNotice, undefined);
});
