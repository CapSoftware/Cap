import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	exportInstant,
	finishNativeWalk,
	nativeWalkPrompt,
	snapshotNativeWalk,
} from "./native-walk.mjs";
import { walkModeName } from "./walk-brand.mjs";

function fixture(t) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "ux-walk-native-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const source = path.join(root, "original.cap");
	const directory = path.join(root, "walk");
	fs.mkdirSync(source);
	fs.mkdirSync(directory);
	fs.writeFileSync(
		path.join(source, "recording-meta.json"),
		JSON.stringify({ status: { status: "Complete" } }),
	);
	fs.writeFileSync(path.join(source, "source.mp4"), "original media");
	const journal = {
		schemaVersion: 1,
		state: "complete",
		startedAtMs: 100000,
		durationMs: 10000,
		sourceProject: source,
		request: {
			directory,
			topic: "Checkout",
			url: "https://example.com",
			speakers: ["Tester"],
		},
		events: [
			{ kind: "note", text: "Clipped button", offsetMs: 1500 },
			{ kind: "chapter", text: "Payment", offsetMs: 4000 },
		],
	};
	const file = path.join(directory, "native-walk.json");
	const save = () => fs.writeFileSync(file, JSON.stringify(journal));
	save();
	return { journal, file, save, directory, source };
}

test("prompt entrypoint runs through a directory alias while non-file argv imports stay inert", (t) => {
	const f = fixture(t);
	const alias = path.join(path.dirname(f.directory), "adapter alias");
	fs.symlinkSync(fileURLToPath(new URL(".", import.meta.url)), alias, "dir");
	const result = spawnSync(
		process.execPath,
		[path.join(alias, "native-walk.mjs"), "prompt", f.file],
		{ encoding: "utf8", timeout: 5000 },
	);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout, `${nativeWalkPrompt(f.file)}\n`);
	const imported = spawnSync(
		process.execPath,
		[
			"--input-type=module",
			"-e",
			`process.argv[1] = "not-a-file"; await import(${JSON.stringify(new URL("./native-walk.mjs", import.meta.url).href)}); console.log("imported");`,
		],
		{ encoding: "utf8", timeout: 5000 },
	);
	assert.equal(imported.status, 0, imported.stderr);
	assert.equal(imported.stdout, "imported\n");
	assert.equal(imported.stderr, "");
});

test("refuses an active or aborted native capture before touching media", async (t) => {
	const f = fixture(t);
	for (const state of ["recording", "aborted"]) {
		f.journal.state = state;
		f.save();
		assert.throws(() => snapshotNativeWalk(f.file), /complete/);
	}
	assert.equal(fs.existsSync(path.join(f.directory, "media")), false);
});

test("snapshots once and preserves original project plus journal on export failure", async (t) => {
	const f = fixture(t);
	const snapshot = snapshotNativeWalk(f.file);
	fs.writeFileSync(path.join(f.source, "source.mp4"), "later editor change");
	assert.equal(snapshotNativeWalk(f.file), snapshot);
	assert.equal(
		fs.readFileSync(path.join(snapshot, "source.mp4"), "utf8"),
		"original media",
	);
	await assert.rejects(
		finishNativeWalk(
			f.file,
			{ transcriber: "none", brief: false },
			{
				client: {
					export: async (project) => {
						assert.equal(project, snapshot);
						throw new Error("Export failed");
					},
				},
			},
		),
		/Export failed/,
	);
	assert.equal(
		fs.readFileSync(path.join(f.source, "source.mp4"), "utf8"),
		"later editor change",
	);
	assert.equal(
		JSON.parse(fs.readFileSync(f.file)).events[0].text,
		"Clipped button",
	);
	assert.equal(fs.existsSync(snapshot), true);
});

test("chapters and notes keep Cap elapsed offsets and retries reuse their saved snapshot", async (t) => {
	const f = fixture(t);
	const spans = [];
	let exports = 0;
	const deps = {
		client: {
			export: async (_project, output) => {
				exports++;
				fs.writeFileSync(output, "export");
				return { durationS: 10 };
			},
		},
		clip: async (_input, output, start, duration) => {
			spans.push([start, duration]);
			fs.writeFileSync(output, "clip");
		},
		processChapter: async (directory, cfg, options) => {
			assert.equal(cfg.transcriber, "none");
			assert.equal(options.brief, false);
			assert.ok(fs.existsSync(path.join(directory, "chapter.json")));
			assert.match(nativeWalkPrompt(f.file), /preparation: processing/);
			return {};
		},
		writeIndex: () => {},
		writeReport: () => {},
	};
	await finishNativeWalk(f.file, { transcriber: "none", brief: false }, deps);
	const session = JSON.parse(
		fs.readFileSync(path.join(f.directory, "session.json")),
	);
	assert.deepEqual(spans, [
		[0, 4],
		[4, 6],
	]);
	assert.equal(session.chapters[1].name, "Payment");
	assert.equal(session.chapters[1].startMs, 104000);
	assert.match(
		fs.readFileSync(path.join(f.directory, "agent-prompt.txt"), "utf8"),
		/preparation: ready/,
	);
	const actions = fs
		.readFileSync(path.join(f.directory, "actions.jsonl"), "utf8")
		.trim()
		.split("\n")
		.map(JSON.parse);
	assert.equal(actions[0].t, 101500);
	assert.equal(actions[0].text, "Clipped button");
	await finishNativeWalk(f.file, { transcriber: "none", brief: false }, deps);
	assert.equal(exports, 1);
	assert.equal(session.coverage.dom, "not captured");
});

test("a partial failed export cannot block a retry or replace the source", async (t) => {
	const f = fixture(t);
	let failed = false;
	const deps = {
		client: {
			export: async (_project, output) => {
				assert.equal(fs.existsSync(output), false);
				fs.writeFileSync(output, "derived movie");
				if (!failed) {
					failed = true;
					throw new Error("Interrupted export");
				}
				return { durationS: 10 };
			},
		},
		clip: async (_input, output) => fs.writeFileSync(output, "clip"),
		processChapter: async () => ({}),
		writeIndex: () => {},
		writeReport: () => {},
	};
	await assert.rejects(
		finishNativeWalk(f.file, { brief: false }, deps),
		/Interrupted export/,
	);
	await finishNativeWalk(f.file, { brief: false }, deps);
	assert.equal(
		fs.readFileSync(path.join(f.source, "source.mp4"), "utf8"),
		"original media",
	);
	const report = fs.readFileSync(path.join(f.directory, "report.html"), "utf8");
	assert.ok(report.includes("Clipped button"));
	assert.ok(report.includes("Payment"));
	assert.ok(report.includes("video.mp4"));
	assert.ok(report.includes(` · ${walkModeName}</title>`));
});

test("the report and agent prompt name the mode from the brand door", (t) => {
	const brand = JSON.parse(
		fs.readFileSync(
			new URL("../../../crates/fork-brand/brand.json", import.meta.url),
			"utf8",
		),
	);
	assert.equal(
		walkModeName,
		brand.walk_mode_name.replaceAll("%app%", brand.display_name),
	);
	assert.doesNotMatch(walkModeName, /%/);
	const f = fixture(t);
	assert.ok(
		nativeWalkPrompt(f.file).startsWith(
			`Review this ${walkModeName} recording: ${f.directory}.`,
		),
	);
});

test("reprocessing recovers a lock left by a process that no longer exists", async (t) => {
	const f = fixture(t);
	const lock = path.join(f.directory, ".processing-lock");
	fs.mkdirSync(lock);
	fs.writeFileSync(
		path.join(lock, "owner.json"),
		JSON.stringify({ pid: 2147483647 }),
	);
	await finishNativeWalk(
		f.file,
		{ transcriber: "none", brief: false },
		{
			client: {
				export: async (_project, output) => {
					fs.writeFileSync(output, "export");
					return { durationS: 10 };
				},
			},
			clip: async (_input, output) => fs.writeFileSync(output, "clip"),
			processChapter: async () => ({}),
			writeIndex: () => {},
			writeReport: () => {},
		},
	);
	assert.equal(fs.existsSync(lock), false);
	assert.equal(fs.existsSync(path.join(f.directory, "report.html")), true);
});

test("processing and reprocessing retain owned browser evidence alongside native notes", async (t) => {
	const f = fixture(t);
	fs.writeFileSync(
		path.join(f.directory, "browser-evidence.json"),
		JSON.stringify({
			schemaVersion: 1,
			captureId: "owned-browser",
			journal: f.file,
			sourceProject: f.source,
			windowId: "17",
			startedAtMs: f.journal.startedAtMs,
			state: "complete",
			anchors: [
				{ wallMs: 100000, offsetMs: 0, paused: false },
				{ wallMs: 110000, offsetMs: 10000, paused: true },
			],
		}),
	);
	fs.writeFileSync(
		path.join(f.directory, "browser-evidence.jsonl"),
		[
			{ ev: "click", observedAt: 100500, el: { tag: "button", text: "Save" } },
			{
				ev: "http",
				observedAt: 102000,
				method: "POST",
				status: 400,
				url: "https://example.com/rest/v1/rpc/save?token=SECRET_SENTINEL",
				resBody: '{"code":"23514","message":"Invalid window"}',
			},
		]
			.map(JSON.stringify)
			.join("\n"),
	);
	const deps = {
		client: {
			export: async (_project, output) => {
				fs.writeFileSync(output, "export");
				return { durationS: 10 };
			},
		},
		clip: async (_input, output) => fs.writeFileSync(output, "clip"),
		processChapter: async () => ({}),
		writeIndex: () => {},
		writeReport: () => {},
	};
	for (let attempt = 0; attempt < 2; attempt++) {
		await finishNativeWalk(f.file, { transcriber: "none", brief: false }, deps);
		const actions = fs
			.readFileSync(path.join(f.directory, "actions.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map(JSON.parse);
		assert.deepEqual(
			actions.map((event) => event.ev),
			["click", "note", "http"],
		);
		assert.deepEqual(
			actions.map((event) => event.t),
			[100500, 101500, 102000],
		);
		assert.equal(JSON.stringify(actions).includes("SECRET_SENTINEL"), false);
		assert.match(
			JSON.parse(fs.readFileSync(path.join(f.directory, "session.json")))
				.coverage.network,
			/captured/,
		);
		assert.match(
			fs.readFileSync(path.join(f.directory, "report.html"), "utf8"),
			/Browser evidence/,
		);
	}
});

test("canonical saved-journal paths accept directory aliases and reject copied journals", (t) => {
	const f = fixture(t);
	const alias = path.join(path.dirname(f.directory), "walk-alias");
	fs.symlinkSync(f.directory, alias, "dir");
	f.journal.request.directory = alias;
	f.save();
	assert.doesNotThrow(() => snapshotNativeWalk(fs.realpathSync(f.file)));
	const copy = path.join(path.dirname(f.directory), "other-walk");
	fs.mkdirSync(copy);
	const copied = path.join(copy, "native-walk.json");
	fs.copyFileSync(f.file, copied);
	assert.throws(() => snapshotNativeWalk(copied), /does not match/);
	assert.equal(fs.existsSync(path.join(copy, "media")), false);
});

test("copying an agent prompt describes recording, aborted and unprocessed walks honestly", (t) => {
	const f = fixture(t);
	for (const state of ["recording", "aborted"]) {
		f.journal.state = state;
		f.journal.durationMs = null;
		f.save();
		const prompt = nativeWalkPrompt(f.file);
		assert.match(prompt, new RegExp(state));
		assert.match(prompt, /not finalized|incomplete|in progress/i);
		assert.equal(fs.existsSync(path.join(f.directory, "media")), false);
	}
	f.journal.state = "complete";
	f.journal.durationMs = 10000;
	f.save();
	assert.match(nativeWalkPrompt(f.file), /not started|not prepared/);
});

test("transcript is saved while export is blocked and reused after export failure", async (t) => {
	const f = fixture(t);
	f.journal.events = [];
	f.save();
	let failExport;
	let enteredExport;
	const entered = new Promise((resolve) => {
		enteredExport = resolve;
	});
	let ready;
	const transcriptReady = new Promise((resolve) => {
		ready = resolve;
	});
	let uploads = 0;
	const transcript = path.join(f.directory, "01-walkthrough/transcript.srt");
	const deps = {
		prepareAudio: async () => ({
			path: path.join(f.directory, "source.m4a"),
			durationS: 10,
		}),
		clipAudio: async (_input, output) => fs.writeFileSync(output, "audio"),
		client: {
			export: async () => {
				enteredExport();
				return new Promise((_resolve, reject) => {
					failExport = reject;
				});
			},
		},
		processChapter: async (directory, _cfg, options) => {
			if (options.transcriptOnly && !fs.existsSync(transcript)) {
				uploads++;
				fs.writeFileSync(
					path.join(directory, "transcript.srt"),
					"1\n00:00:00,000 --> 00:00:01,000\nSpeaker 1: Saved.\n",
				);
				ready();
			}
			return { transcript: true };
		},
		writeIndex: () => {},
		writeReport: () => {},
	};
	const running = finishNativeWalk(f.file, { transcriber: "elevenlabs" }, deps);
	const rejected = assert.rejects(running, /Export unavailable/);
	await entered;
	const observed = await Promise.race([
		transcriptReady.then(() => true),
		new Promise((resolve) => setTimeout(() => resolve(false), 250)),
	]);
	failExport(new Error("Export unavailable"));
	await rejected;
	assert.equal(
		observed,
		true,
		"transcription must finish while export is unresolved",
	);
	assert.match(fs.readFileSync(transcript, "utf8"), /Saved/);
	deps.client.export = async (_project, output) => {
		fs.writeFileSync(output, "verified export");
		return { durationS: 10 };
	};
	deps.clip = async () => {
		throw new Error("full-session video must be reused");
	};
	await finishNativeWalk(f.file, { transcriber: "elevenlabs" }, deps);
	assert.equal(uploads, 1);
	assert.equal(
		fs.readFileSync(path.join(f.directory, "01-walkthrough/video.mp4"), "utf8"),
		"verified export",
	);
});

test("one chapter reuses a full export but still trims a longer export", async (t) => {
	for (const exportedS of [10, 15]) {
		const f = fixture(t);
		f.journal.events = [];
		f.save();
		const spans = [];
		await finishNativeWalk(
			f.file,
			{ transcriber: "none" },
			{
				client: {
					export: async (_project, output) => {
						fs.writeFileSync(output, "export");
						return { durationS: exportedS };
					},
				},
				clip: async (_input, output, start, duration) => {
					spans.push([start, duration]);
					fs.writeFileSync(output, "clipped");
				},
				processChapter: async () => ({}),
				writeIndex: () => {},
				writeReport: () => {},
			},
		);
		assert.deepEqual(spans, exportedS === 10 ? [] : [[0, 10]]);
	}
});

test("real source AAC and the configured provider save words before the video export finishes", async (t) => {
	const f = fixture(t);
	f.journal.durationMs = 1000;
	f.journal.events = [];
	f.save();
	const video = spawnSync(
		"ffmpeg",
		[
			"-v",
			"error",
			"-y",
			"-f",
			"lavfi",
			"-i",
			"color=size=32x32:rate=10:duration=1",
			"-c:v",
			"libx264",
			"-threads",
			"1",
			path.join(f.source, "source.mp4"),
		],
		{ encoding: "utf8" },
	);
	assert.equal(video.status, 0, video.stderr);
	const audio = spawnSync(
		"ffmpeg",
		[
			"-v",
			"error",
			"-f",
			"lavfi",
			"-i",
			"sine=frequency=440:duration=1",
			"-c:a",
			"aac",
			path.join(f.source, "mic.m4a"),
		],
		{ encoding: "utf8" },
	);
	assert.equal(audio.status, 0, audio.stderr);
	fs.writeFileSync(
		path.join(f.source, "recording-meta.json"),
		JSON.stringify({
			status: { status: "Complete" },
			segments: [
				{
					display: { path: "source.mp4", start_time: 0 },
					mic: { path: "mic.m4a", start_time: 0 },
				},
			],
		}),
	);
	const old = process.env.ELEVENLABS_API_KEY;
	process.env.ELEVENLABS_API_KEY = "synthetic-test-key";
	t.after(() => {
		if (old === undefined) delete process.env.ELEVENLABS_API_KEY;
		else process.env.ELEVENLABS_API_KEY = old;
	});
	let uploads = 0;
	t.mock.method(globalThis, "fetch", async () => {
		uploads++;
		return new Response(
			JSON.stringify({
				words: [
					{
						type: "word",
						text: "Recovered.",
						start: 0.05,
						end: 0.4,
						speaker_id: "speaker_0",
					},
				],
			}),
		);
	});
	const { processChapter } = await import(
		"../../../vendor/ux-walk/src/process.mjs"
	);
	let failExport;
	const deps = {
		client: {
			export: async () =>
				new Promise((_resolve, reject) => {
					failExport = reject;
				}),
		},
		processChapter: (directory, cfg, options) =>
			options.transcriptOnly
				? processChapter(directory, cfg, options)
				: Promise.resolve({}),
		writeIndex: () => {},
		writeReport: () => {},
	};
	const cfg = {
		transcriber: "elevenlabs",
		glossary: "",
		brief: false,
		sections: false,
	};
	const running = finishNativeWalk(f.file, cfg, deps);
	const rejected = assert.rejects(running, /Synthetic export failure/);
	const transcript = path.join(f.directory, "01-walkthrough/transcript.srt");
	const deadline = Date.now() + 5000;
	while (!fs.existsSync(transcript) && Date.now() < deadline)
		await new Promise((resolve) => setTimeout(resolve, 10));
	failExport(new Error("Synthetic export failure"));
	await rejected;
	assert.match(fs.readFileSync(transcript, "utf8"), /Recovered/);
	assert.equal(uploads, 1);
	const state = JSON.parse(
		fs.readFileSync(path.join(f.directory, "processing.json")),
	);
	assert.equal(state.transcript, "ready");
	assert.equal(state.video, "failed");
	deps.client.export = async (_project, output) => {
		fs.writeFileSync(output, "verified export");
		return { durationS: 1 };
	};
	await finishNativeWalk(f.file, cfg, deps);
	assert.equal(uploads, 1);
});

test("a shorter final export bounds chapter captions and keeps the full source transcript", async (t) => {
	const f = fixture(t);
	f.journal.events = [];
	f.save();
	await finishNativeWalk(
		f.file,
		{ transcriber: "elevenlabs" },
		{
			prepareAudio: async () => ({ path: "source.m4a", durationS: 10 }),
			clipAudio: async (_input, output) => fs.writeFileSync(output, "audio"),
			client: {
				export: async (_project, output) => {
					fs.writeFileSync(output, "verified export");
					return { durationS: 5 };
				},
			},
			processChapter: async (directory, _cfg, options) => {
				if (options.transcriptOnly)
					fs.writeFileSync(
						path.join(directory, "transcript.srt"),
						"1\n00:00:04,000 --> 00:00:06,000\nSpeaker 1: Boundary.\n\n2\n00:00:08,000 --> 00:00:09,000\nSpeaker 1: Outside.\n",
					);
				return { transcript: true };
			},
			writeIndex: () => {},
			writeReport: () => {},
		},
	);
	const directory = path.join(f.directory, "01-walkthrough");
	const captions = fs.readFileSync(
		path.join(directory, "transcript.srt"),
		"utf8",
	);
	assert.match(captions, /00:00:04,000 --> 00:00:05,000/);
	assert.doesNotMatch(captions, /Outside/);
	assert.match(
		fs.readFileSync(path.join(directory, "transcript-source.srt"), "utf8"),
		/Outside/,
	);
});

test("early provider rejection stays visible in final summary and index without a second upload or brief", async (t) => {
	const f = fixture(t);
	f.journal.durationMs = 1000;
	f.journal.events = [];
	f.save();
	const media = spawnSync(
		"ffmpeg",
		[
			"-v",
			"error",
			"-y",
			"-f",
			"lavfi",
			"-i",
			"color=size=32x32:rate=10:duration=1",
			"-f",
			"lavfi",
			"-i",
			"sine=frequency=440:duration=1",
			"-c:v",
			"libx264",
			"-threads",
			"1",
			"-c:a",
			"aac",
			"-shortest",
			path.join(f.source, "source.mp4"),
		],
		{ encoding: "utf8" },
	);
	assert.equal(media.status, 0, media.stderr);
	fs.writeFileSync(
		path.join(f.source, "recording-meta.json"),
		JSON.stringify({
			status: { status: "Complete" },
			segments: [
				{
					display: { path: "source.mp4", start_time: 0 },
					mic: { path: "source.mp4", start_time: 0 },
				},
			],
		}),
	);
	const old = process.env.ELEVENLABS_API_KEY;
	process.env.ELEVENLABS_API_KEY = "synthetic-test-key";
	t.after(() => {
		if (old === undefined) delete process.env.ELEVENLABS_API_KEY;
		else process.env.ELEVENLABS_API_KEY = old;
	});
	let uploads = 0;
	t.mock.method(globalThis, "fetch", async () => {
		uploads++;
		return new Response("Synthetic invalid key", { status: 401 });
	});
	const { processChapter } = await import(
		"../../../vendor/ux-walk/src/process.mjs"
	);
	let finalOptions;
	await finishNativeWalk(
		f.file,
		{ transcriber: "elevenlabs", glossary: "", brief: true, sections: false },
		{
			client: {
				export: async (_project, output) => {
					fs.copyFileSync(path.join(f.source, "source.mp4"), output);
					return { durationS: 1 };
				},
			},
			processChapter: (directory, cfg, options) => {
				if (!options.transcriptOnly) finalOptions = options;
				return processChapter(directory, cfg, options);
			},
			writeReport: () => {},
		},
	);
	const summary = JSON.parse(
		fs.readFileSync(path.join(f.directory, "01-walkthrough/summary.json")),
	);
	assert.match(summary.transcriptError, /ElevenLabs 401/);
	assert.match(
		fs.readFileSync(path.join(f.directory, "index.md"), "utf8"),
		/no transcript/,
	);
	assert.equal(finalOptions.brief, false);
	assert.equal(uploads, 1);
});

test("a partial live cache never reports transcript ready or automatically resubmits missing coverage", async (t) => {
	const f = fixture(t);
	f.journal.events = f.journal.events.filter((event) => event.kind === "note");
	f.save();
	const { durableJson, sha256 } = await import("./checkpoint-store.mjs");
	const root = path.join(f.directory, "checkpoints");
	fs.mkdirSync(path.join(root, "jobs"), { recursive: true });
	durableJson(path.join(root, "final-layout.json"), {
		displaySpans: [10],
		meta: {
			segments: [{ display: { start_time: 0 }, mic: { start_time: 0 } }],
		},
		config: {},
	});
	const id = "b".repeat(64);
	const resultFile = path.join(root, `jobs/${id}.words.json`);
	durableJson(resultFile, {
		source: "segment-0:microphone",
		words: [
			{
				start: 0,
				end: 1,
				text: "saved speech",
				speaker: "unique-chunk-speaker",
			},
		],
	});
	durableJson(path.join(root, `jobs/${id}.json`), {
		jobId: id,
		source: "segment-0:microphone",
		sourceStartMs: 0,
		sourceEndMs: 1000,
		state: "complete",
		resultHash: sha256(fs.readFileSync(resultFile)),
	});
	await finishNativeWalk(
		f.file,
		{ transcriber: "elevenlabs", brief: true },
		{
			client: {
				export: async (_project, output) => {
					fs.writeFileSync(output, "export");
					return { durationS: 10 };
				},
			},
			prepareAudio: async () => {
				throw new Error("Must reuse saved jobs");
			},
			processChapter: async (_directory, cfg, options) => {
				assert.equal(cfg.transcriber, "none");
				assert.equal(options.brief, false);
				assert.deepEqual(options.speakers, ["Tester"]);
				return { transcript: true };
			},
			writeIndex: () => {},
			writeReport: () => {},
		},
	);
	const status = JSON.parse(
		fs.readFileSync(path.join(f.directory, "processing.json")),
	);
	assert.equal(status.transcript, "partial");
	const chapter = JSON.parse(
		fs.readFileSync(path.join(f.directory, "session.json")),
	).chapters[0];
	assert.equal(chapter.status, "no transcript");
	assert.match(
		JSON.parse(
			fs.readFileSync(path.join(f.directory, chapter.dir, "summary.json")),
		).transcriptError,
		/partial/i,
	);
});

test("a walk whose voices cannot be matched across chunks carries the notice into the report", async (t) => {
	const f = fixture(t);
	f.journal.events = f.journal.events.filter((event) => event.kind === "note");
	f.journal.request.speakers = ["Ann", "Bo"];
	f.save();
	const { durableJson, sha256 } = await import("./checkpoint-store.mjs");
	const root = path.join(f.directory, "checkpoints");
	fs.mkdirSync(path.join(root, "jobs"), { recursive: true });
	durableJson(path.join(root, "final-layout.json"), {
		displaySpans: [10],
		meta: {
			segments: [{ display: { start_time: 0 }, mic: { start_time: 0 } }],
		},
		config: {},
	});
	for (const [fill, startMs] of [
		["c", 0],
		["d", 5000],
	]) {
		const id = fill.repeat(64);
		const resultFile = path.join(root, `jobs/${id}.words.json`);
		durableJson(resultFile, {
			source: "segment-0:microphone",
			words: [
				{
					start: startMs / 1000,
					end: startMs / 1000 + 1,
					text: "saved speech",
					speaker: `${fill}:speaker_0`,
				},
			],
		});
		durableJson(path.join(root, `jobs/${id}.json`), {
			jobId: id,
			source: "segment-0:microphone",
			sourceStartMs: startMs,
			sourceEndMs: startMs + 5000,
			state: "complete",
			resultHash: sha256(fs.readFileSync(resultFile)),
		});
	}
	await finishNativeWalk(
		f.file,
		{ transcriber: "elevenlabs" },
		{
			client: {
				export: async (_project, output) => {
					fs.writeFileSync(output, "export");
					return { durationS: 10 };
				},
			},
			prepareAudio: async () => {
				throw new Error("Must reuse saved jobs");
			},
			processChapter: async (_directory, _cfg, options) => {
				assert.deepEqual(options.speakers, []);
				return { transcript: true };
			},
			writeIndex: () => {},
			writeReport: () => {},
		},
	);
	const chapter = JSON.parse(
		fs.readFileSync(path.join(f.directory, "session.json")),
	).chapters[0];
	assert.match(chapter.speakerAttributionNotice, /can be the same person/);
});

test("explicit full transcription is available after unsupported live capture and ordinary reprocess reuses it", async (t) => {
	const f = fixture(t);
	let submissions = 0;
	const deps = {
		fullTranscription: true,
		client: {
			export: async (_project, output) => {
				fs.writeFileSync(output, "export");
				return { durationS: 10 };
			},
		},
		clip: async (_input, output) => fs.writeFileSync(output, "clip"),
		prepareAudio: async () => null,
		processChapter: async (directory, cfg) => {
			if (
				cfg.transcriber !== "none" &&
				!fs.existsSync(path.join(directory, "transcript.srt"))
			) {
				submissions++;
				fs.writeFileSync(
					path.join(directory, "transcript.srt"),
					"1\n00:00:00,000 --> 00:00:01,000\nSaved full transcript\n",
				);
			}
			return { transcript: true };
		},
		writeIndex: () => {},
		writeReport: () => {},
	};
	await finishNativeWalk(f.file, { transcriber: "elevenlabs" }, deps);
	assert.equal(submissions, 2);
	assert.ok(
		fs.existsSync(path.join(f.directory, "checkpoints/full-transcript.json")),
	);
	await finishNativeWalk(
		f.file,
		{ transcriber: "elevenlabs" },
		{ ...deps, fullTranscription: false },
	);
	assert.equal(submissions, 2);
	assert.equal(
		JSON.parse(fs.readFileSync(path.join(f.directory, "processing.json")))
			.transcript,
		"ready",
	);
});

test("an unverified full-caption cache is quarantined before normal timelines can parse it", async (t) => {
	const f = fixture(t);
	f.journal.events = [];
	f.save();
	let submissions = 0;
	let parsedBad = false;
	const deps = {
		client: {
			export: async (_project, output) => {
				fs.writeFileSync(output, "export");
				return { durationS: 10 };
			},
		},
		prepareAudio: async () => null,
		processChapter: async (directory, cfg) => {
			const file = path.join(directory, "transcript.srt");
			if (cfg.transcriber !== "none") {
				submissions++;
				fs.writeFileSync(
					file,
					"1\n00:00:00,000 --> 00:00:01,000\nVerified speech\n",
				);
			}
			if (fs.existsSync(file))
				parsedBad ||= fs.readFileSync(file, "utf8").includes("CORRUPTED");
			return { transcript: fs.existsSync(file) };
		},
		writeIndex: () => {},
		writeReport: () => {},
	};
	await finishNativeWalk(
		f.file,
		{ transcriber: "elevenlabs" },
		{ ...deps, fullTranscription: true },
	);
	const row = JSON.parse(
		fs.readFileSync(path.join(f.directory, "session.json")),
	).chapters[0];
	fs.writeFileSync(
		path.join(f.directory, row.dir, "transcript.srt"),
		"1\n00:00:00,000 --> 00:00:01,000\nCORRUPTED UNVERIFIED CAPTION\n",
	);
	await finishNativeWalk(f.file, { transcriber: "elevenlabs" }, deps);
	assert.equal(submissions, 1);
	assert.equal(parsedBad, false);
	assert.equal(
		fs.existsSync(path.join(f.directory, row.dir, "transcript.srt")),
		false,
	);
	assert.ok(
		fs
			.readdirSync(path.join(f.directory, row.dir))
			.some((name) => name.startsWith("transcript-unverified-")),
	);
});

test("sealed unsupported zero-job capture falls back once after stop and caches the result", async (t) => {
	const f = fixture(t);
	f.journal.events = [];
	f.save();
	const segment = path.join(f.source, "content/segments/segment-0");
	fs.mkdirSync(segment, { recursive: true });
	fs.writeFileSync(
		path.join(segment, "audio-input.ogg"),
		"unsupported synthetic source",
	);
	const { durableJson } = await import("./checkpoint-store.mjs");
	durableJson(path.join(f.directory, "checkpoint-heartbeat.json"), {
		wallMs: 110000,
		activeElapsedMs: 10000,
		parentPid: process.pid,
		generation: 1,
		paused: true,
		captureEnded: true,
	});
	const { runCheckpointWorker } = await import("./checkpoint-worker.mjs");
	await runCheckpointWorker(
		f.file,
		{ transcriber: "elevenlabs" },
		{
			transport: { status: async () => ({ backupEnabled: false, server: "" }) },
		},
	);
	let submissions = 0;
	const deps = {
		client: {
			export: async (_project, output) => {
				fs.writeFileSync(output, "export");
				return { durationS: 10 };
			},
		},
		prepareAudio: async () => null,
		processChapter: async (directory, cfg) => {
			const srt = path.join(directory, "transcript.srt");
			if (cfg.transcriber !== "none" && !fs.existsSync(srt)) {
				submissions++;
				fs.writeFileSync(
					srt,
					"1\n00:00:00,000 --> 00:00:01,000\nStop-time fallback\n",
				);
			}
			return { transcript: fs.existsSync(srt) };
		},
		writeIndex: () => {},
		writeReport: () => {},
	};
	await finishNativeWalk(f.file, { transcriber: "elevenlabs" }, deps);
	assert.equal(submissions, 1);
	await finishNativeWalk(f.file, { transcriber: "elevenlabs" }, deps);
	assert.equal(submissions, 1);
});

function diatribeFixture(t) {
	const f = fixture(t);
	// An Instant project: a finished video and no Studio segments.
	fs.writeFileSync(
		path.join(f.source, "recording-meta.json"),
		JSON.stringify({ pretty_name: "Talk", fps: 30, sample_rate: 48000 }),
	);
	fs.mkdirSync(path.join(f.source, "content"));
	fs.writeFileSync(path.join(f.source, "content/output.mp4"), "instant");
	f.journal.request.kind = "diatribe";
	f.journal.request.topic = "Diatribe";
	f.journal.request.url = "";
	f.journal.events = [
		{ kind: "note", text: "Importer before billing", offsetMs: 1500 },
	];
	f.save();
	// Left over from a walk: a diatribe must not read browser evidence.
	fs.writeFileSync(
		path.join(f.directory, "browser-evidence.json"),
		JSON.stringify({ schemaVersion: 1, state: "unavailable", reason: "x" }),
	);
	return f;
}

test("a diatribe is processed as kind diatribe with a forced brief and no browser", async (t) => {
	const f = diatribeFixture(t);
	const briefs = [];
	const deps = {
		client: {
			export: async () => {
				throw new Error("An Instant project must not take the web export");
			},
		},
		exportInstant: async (_client, project, output) => {
			assert.equal(project, path.join(f.directory, "media/source.cap"));
			fs.writeFileSync(output, "instant export");
			return { durationS: 10 };
		},
		clip: async () => {
			throw new Error("One chapter reuses the whole export");
		},
		prepareAudio: async () => null,
		processChapter: async (directory, cfg, options) => {
			const chapter = JSON.parse(
				fs.readFileSync(path.join(directory, "chapter.json"), "utf8"),
			);
			assert.equal(chapter.kind, "diatribe");
			assert.equal(cfg.brief, false);
			if (!options.transcriptOnly) briefs.push(options.brief);
			return {};
		},
		writeIndex: () => {},
		writeReport: () => {},
	};
	await finishNativeWalk(f.file, { transcriber: "none", brief: false }, deps);
	assert.deepEqual(briefs, [true]);
	const session = JSON.parse(
		fs.readFileSync(path.join(f.directory, "session.json"), "utf8"),
	);
	assert.equal(session.kind, "diatribe");
	assert.equal(session.url, null);
	assert.deepEqual(Object.keys(session.coverage), ["window"]);
	assert.deepEqual(
		session.chapters.map((chapter) => chapter.dir),
		["01-diatribe"],
	);
	assert.equal(
		fs.readFileSync(path.join(f.directory, "01-diatribe/video.mp4"), "utf8"),
		"instant export",
	);
	const report = fs.readFileSync(path.join(f.directory, "report.html"), "utf8");
	assert.ok(report.includes("Importer before billing"));
	assert.ok(report.includes("<title>Diatribe · Diatribe</title>"));
	assert.ok(!report.includes("Browser evidence"));
	const prompt = fs.readFileSync(
		path.join(f.directory, "agent-prompt.txt"),
		"utf8",
	);
	assert.ok(
		prompt.startsWith(
			`Turn the action items into beads (or issues) from this diatribe: ${f.directory}.`,
		),
	);
	assert.match(prompt, /preparation: ready/);
	assert.match(prompt, /ux-walk'? items .*--json/);
	assert.doesNotMatch(prompt, /Browser coverage/);
	assert.ok(!walkModeName.includes("Diatribe"));
});

test("an ordinary recording's notes are processed like a diatribe under its own name", async (t) => {
	const f = fixture(t);
	// A Studio recording: the notes pass takes the ordinary export and no browser evidence.
	f.journal.request.kind = "notes";
	f.journal.request.topic = "Standup";
	f.journal.request.url = "";
	f.journal.events = [];
	f.save();
	fs.writeFileSync(
		path.join(f.directory, "browser-evidence.json"),
		JSON.stringify({ schemaVersion: 1, state: "unavailable", reason: "x" }),
	);
	const briefs = [];
	await finishNativeWalk(
		f.file,
		{ transcriber: "none", brief: false },
		{
			client: {
				export: async (_project, output) => {
					fs.writeFileSync(output, "studio export");
					return { durationS: 10 };
				},
			},
			exportInstant: async () => {
				throw new Error("A Studio project must not take the Instant export");
			},
			clip: async (_input, output) => fs.writeFileSync(output, "clip"),
			prepareAudio: async () => null,
			processChapter: async (directory, _cfg, options) => {
				const chapter = JSON.parse(
					fs.readFileSync(path.join(directory, "chapter.json"), "utf8"),
				);
				assert.equal(chapter.kind, "diatribe");
				if (!options.transcriptOnly) briefs.push(options.brief);
				return {};
			},
			writeIndex: () => {},
			writeReport: () => {},
		},
	);
	assert.deepEqual(briefs, [true]);
	const session = JSON.parse(
		fs.readFileSync(path.join(f.directory, "session.json"), "utf8"),
	);
	assert.equal(session.kind, "diatribe");
	assert.equal(session.url, null);
	assert.deepEqual(Object.keys(session.coverage), ["window"]);
	assert.deepEqual(
		session.chapters.map((chapter) => chapter.dir),
		["01-notes"],
	);
	const report = fs.readFileSync(path.join(f.directory, "report.html"), "utf8");
	assert.ok(report.includes("<title>Standup · Notes</title>"));
	assert.ok(!report.includes("Browser evidence"));
	const prompt = fs.readFileSync(
		path.join(f.directory, "agent-prompt.txt"),
		"utf8",
	);
	assert.match(prompt, /from the notes of this recording: /);
	assert.doesNotMatch(prompt, /Browser coverage/);
});

test("a walk keeps its brief setting and browser coverage", async (t) => {
	const f = fixture(t);
	const briefs = [];
	await finishNativeWalk(
		f.file,
		{ transcriber: "none", brief: false },
		{
			client: {
				export: async (_project, output) => {
					fs.writeFileSync(output, "export");
					return { durationS: 10 };
				},
			},
			clip: async (_input, output) => fs.writeFileSync(output, "clip"),
			processChapter: async (directory, _cfg, options) => {
				const chapter = JSON.parse(
					fs.readFileSync(path.join(directory, "chapter.json"), "utf8"),
				);
				assert.equal(chapter.kind, "native-cap");
				briefs.push(options.brief);
				return {};
			},
			writeIndex: () => {},
			writeReport: () => {},
		},
	);
	assert.deepEqual(briefs, [false, false]);
	const session = JSON.parse(
		fs.readFileSync(path.join(f.directory, "session.json"), "utf8"),
	);
	assert.equal(session.chapters[0].dir, "01-walkthrough");
	assert.ok("dom" in session.coverage);
});

test("an unfinished diatribe's prompt says so", (t) => {
	const f = diatribeFixture(t);
	f.journal.state = "recording";
	f.journal.durationMs = null;
	f.save();
	const prompt = nativeWalkPrompt(f.file);
	assert.match(prompt, /Capture state: recording/);
	assert.match(prompt, /incomplete or still in progress/);
});

test("Instant export copies the finished video at Cap's default settings", async (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "ux-walk-instant-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const video = path.join(root, "made.mp4");
	const made = spawnSync(
		"ffmpeg",
		[
			"-v",
			"error",
			"-y",
			"-f",
			"lavfi",
			"-i",
			"color=size=32x32:rate=10:duration=1",
			"-c:v",
			"libx264",
			"-threads",
			"1",
			video,
		],
		{ encoding: "utf8" },
	);
	assert.equal(made.status, 0, made.stderr);
	const output = path.join(root, "out.mp4");
	let args;
	const client = {
		exportEvents: async (given) => {
			args = given;
			fs.copyFileSync(video, output);
			return { type: "Completed", path: output };
		},
	};
	const info = await exportInstant(client, "/p/source.cap", output);
	assert.deepEqual(args, [
		"export",
		"/p/source.cap",
		"--output",
		output,
		"--format",
		"mp4",
	]);
	assert.ok(info.durationS > 0.5);
	await assert.rejects(
		exportInstant(client, "/p/source.cap", output),
		/Refusing/,
	);
	const missing = path.join(root, "missing.mp4");
	await assert.rejects(
		exportInstant(
			{ exportEvents: async () => ({ type: "Completed", path: missing }) },
			"/p/source.cap",
			missing,
		),
		/did not produce/,
	);
});

function processedItems(f, kind = null) {
	const chapter = path.join(f.directory, "01-intro");
	fs.mkdirSync(chapter);
	fs.writeFileSync(
		path.join(f.directory, "session.json"),
		JSON.stringify({
			topic: "Checkout",
			speakers: ["Tester"],
			...(kind ? { kind } : {}),
			chapters: [{ n: 1, name: "Intro", dir: "01-intro" }],
		}),
	);
	fs.writeFileSync(
		path.join(chapter, "chapter.json"),
		JSON.stringify({ n: 1, name: "Intro" }),
	);
	fs.writeFileSync(
		path.join(chapter, "items.json"),
		JSON.stringify({
			chapter: 1,
			title: "Intro",
			items: [
				{
					id: "C1-01",
					key: "c1-clipped",
					note: 1,
					type: "bug",
					title: "Pay button is clipped",
					when: "0:01",
					priority: "high",
				},
				{
					id: "C1-02",
					key: "c1-copy",
					note: null,
					type: "ask",
					title: "Rename the total",
					when: "0:05",
				},
			],
			decisions: ["Keep the summary"],
			questions: [{ id: "C1-Q1", when: null, text: "Who owns tax?" }],
		}),
	);
	return chapter;
}

function engineCommand(args) {
	const result = spawnSync(
		process.execPath,
		[fileURLToPath(new URL("./native-walk.mjs", import.meta.url)), ...args],
		{ encoding: "utf8", timeout: 10000 },
	);
	return result;
}

test("items and save-items round-trip the owner's edits through the engine", (t) => {
	const f = fixture(t);
	processedItems(f);
	const read = engineCommand(["items", f.file]);
	assert.equal(read.status, 0, read.stderr);
	const merged = JSON.parse(read.stdout);
	assert.equal(merged.session, f.directory);
	const [chapter] = merged.chapters;
	assert.deepEqual(
		chapter.items.map((item) => [item.key, item.origin, item.edited]),
		[
			["c1-clipped", "brief", false],
			["c1-copy", "brief", false],
		],
	);
	assert.deepEqual(chapter.items[0].original, {
		title: "Pay button is clipped",
		type: "bug",
		priority: "high",
		owner: null,
		due: null,
	});
	assert.deepEqual(chapter.decisions, ["Keep the summary"]);
	const request = path.join(f.directory, "save-request.json");
	fs.writeFileSync(
		request,
		JSON.stringify({
			journal: f.file,
			edits: {
				version: 1,
				updatedAt: null,
				items: {
					"c1-clipped": { title: "Pay button clipped on mobile", owner: "Sam" },
					"c1-copy": { deleted: true },
				},
				added: [
					{
						key: "uadded0001",
						chapter: 1,
						title: "Add a receipt",
						note: "Ask Jo",
					},
				],
				order: ["uadded0001", "c1-clipped", "c1-copy"],
			},
		}),
	);
	const saved = engineCommand(["save-items", request]);
	assert.equal(saved.status, 0, saved.stderr);
	const after = JSON.parse(saved.stdout);
	const items = after.chapters[0].items;
	assert.deepEqual(
		items.map((item) => [item.key, item.origin, item.edited, item.deleted]),
		[
			["uadded0001", "user", false, false],
			["c1-clipped", "brief", true, false],
			["c1-copy", "brief", false, true],
		],
	);
	assert.equal(items[1].title, "Pay button clipped on mobile");
	assert.equal(items[1].owner, "Sam");
	assert.equal(items[1].original.title, "Pay button is clipped");
	assert.equal(items[0].userNote, "Ask Jo");
	assert.equal(items[0].type, "ask");
	assert.equal(items[0].original, undefined);
	assert.ok(fs.existsSync(path.join(f.directory, "edits.json")));
	const reread = JSON.parse(engineCommand(["items", f.file]).stdout);
	assert.deepEqual(reread.chapters, after.chapters);
});

test("save-items refuses invalid edits and leaves the saved edits untouched", (t) => {
	const f = fixture(t);
	processedItems(f);
	const request = path.join(f.directory, "save-request.json");
	fs.writeFileSync(
		request,
		JSON.stringify({
			journal: f.file,
			edits: { version: 1, items: { "c1-copy": { title: "" } }, added: [] },
		}),
	);
	const refused = engineCommand(["save-items", request]);
	assert.equal(refused.status, 1);
	assert.match(refused.stderr, /title: must be a non-empty string/);
	assert.equal(fs.existsSync(path.join(f.directory, "edits.json")), false);
	const unprocessed = fixture(t);
	const missing = engineCommand(["items", unprocessed.file]);
	assert.equal(missing.status, 1);
	assert.match(missing.stderr, /Process this walk/);
});

test("the agent prompt points at the edited items for the walk folder", (t) => {
	const f = fixture(t);
	assert.doesNotMatch(nativeWalkPrompt(f.file), / items .*--json/);
	processedItems(f);
	const prompt = nativeWalkPrompt(f.file);
	const cli = fileURLToPath(
		new URL("../../../vendor/ux-walk/bin/ux-walk", import.meta.url),
	);
	assert.ok(
		prompt.includes(
			`'${process.execPath}' '${cli}' items '${f.directory}' --json`,
		),
		prompt,
	);
	assert.match(prompt, /"deleted": true/);
	assert.match(prompt, /link '.*' <key> <ref>/);
	const read = spawnSync(
		process.execPath,
		[cli, "items", f.directory, "--json"],
		{ encoding: "utf8", timeout: 10000 },
	);
	assert.equal(read.status, 0, read.stderr);
	assert.equal(JSON.parse(read.stdout).chapters[0].items.length, 2);
});

// A config dir with projects, and a fake `bd` that records each create and prints an issue id.
function trackerWorld(t) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "ux-walk-filing-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const config = path.join(root, "config");
	const bin = path.join(root, "bin");
	const repo = path.join(root, "repo");
	const calls = path.join(root, "bd-calls.jsonl");
	for (const dir of [path.join(config, "projects"), bin, repo])
		fs.mkdirSync(dir, { recursive: true });
	const bd = path.join(bin, "bd");
	fs.writeFileSync(
		bd,
		`#!${process.execPath}
const fs = require("node:fs");
let body = "";
process.stdin.on("data", (d) => (body += d));
process.stdin.on("end", () => {
	const args = process.argv.slice(2);
	if (args[0] !== "create") return;
	const title = args[args.indexOf("--title") + 1];
	if (title.includes("FAIL")) { console.error("bd refused " + title); process.exit(1); }
	const n = fs.existsSync(${JSON.stringify(calls)}) ? fs.readFileSync(${JSON.stringify(calls)}, "utf8").split("\\n").filter(Boolean).length + 1 : 1;
	fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ args, cwd: process.cwd(), body }) + "\\n");
	console.log(JSON.stringify({ id: "wk-" + n }));
});
`,
		{ mode: 0o755 },
	);
	const glossary = path.join(root, "checkout.txt");
	const project = (id, extra = {}) =>
		fs.writeFileSync(
			path.join(config, "projects", `${id}.json`),
			JSON.stringify({ version: 1, id, name: id.toUpperCase(), ...extra }),
		);
	project("shop", {
		name: "Shop",
		glossary,
		tracker: { provider: "beads", target: repo, targetName: "shop repo" },
	});
	project("plain", { name: "Plain" });
	fs.writeFileSync(path.join(config, "projects", "broken.json"), "{");
	const env = {
		...process.env,
		CAP_UX_WALK_CONFIG_DIR: config,
		PATH: `${bin}:${process.env.PATH}`,
	};
	const command = (args) =>
		spawnSync(
			process.execPath,
			[fileURLToPath(new URL("./native-walk.mjs", import.meta.url)), ...args],
			{ encoding: "utf8", timeout: 20000, env },
		);
	const request = (dir, name, body) => {
		const file = path.join(dir, `${name}.json`);
		fs.writeFileSync(file, JSON.stringify(body));
		return file;
	};
	const created = () =>
		fs.existsSync(calls)
			? fs
					.readFileSync(calls, "utf8")
					.split("\n")
					.filter(Boolean)
					.map((line) => JSON.parse(line))
			: [];
	return { root, config, repo, glossary, command, request, created };
}

function inProject(f, id) {
	const file = path.join(f.directory, "session.json");
	const session = JSON.parse(fs.readFileSync(file, "utf8"));
	fs.writeFileSync(file, JSON.stringify({ ...session, project: id }));
}

test("file previews, then files the chosen items once and links them", (t) => {
	const w = trackerWorld(t);
	const f = fixture(t);
	processedItems(f);
	inProject(f, "shop");
	const keys = ["c1-clipped", "c1-copy"];
	const preview = w.command([
		"file",
		w.request(f.directory, "dry", { journal: f.file, keys, dryRun: true }),
	]);
	assert.equal(preview.status, 0, preview.stderr);
	const dry = JSON.parse(preview.stdout);
	assert.equal(dry.dryRun, true);
	assert.equal(dry.tracker, "beads");
	assert.equal(dry.targetName, "shop repo");
	assert.deepEqual(
		dry.filed.map((item) => [item.key, item.title]),
		[
			["c1-clipped", "Pay button is clipped"],
			["c1-copy", "Rename the total"],
		],
	);
	assert.equal(dry.filed[0].issue, undefined);
	assert.equal(w.created().length, 0, "a dry run creates nothing");
	assert.equal(fs.existsSync(path.join(f.directory, "ledger.json")), false);

	const real = w.command([
		"file",
		w.request(f.directory, "real", { journal: f.file, keys }),
	]);
	assert.equal(real.status, 0, real.stderr);
	const filed = JSON.parse(real.stdout);
	assert.deepEqual(
		filed.filed.map((item) => [item.key, item.ref, item.tracker]),
		[
			["c1-clipped", "wk-1", "beads"],
			["c1-copy", "wk-2", "beads"],
		],
	);
	assert.deepEqual(filed.failed, []);
	assert.equal(w.created().length, 2);
	assert.equal(w.created()[0].cwd, fs.realpathSync(w.repo));
	const items = JSON.parse(w.command(["items", f.file]).stdout).chapters[0]
		.items;
	assert.deepEqual(
		items.map((item) => item.refs.map((ref) => [ref.ref, ref.tracker])),
		[[["wk-1", "beads"]], [["wk-2", "beads"]]],
	);

	const again = w.command([
		"file",
		w.request(f.directory, "again", { journal: f.file, keys }),
	]);
	assert.equal(again.status, 0, again.stderr);
	const second = JSON.parse(again.stdout);
	assert.deepEqual(second.filed, []);
	assert.deepEqual(
		second.skipped.map((item) => item.key),
		keys,
	);
	assert.equal(w.created().length, 2, "a second run files nothing twice");
});

test("file reports per-item failures, refuses an empty choice and needs a tracker", (t) => {
	const w = trackerWorld(t);
	const f = fixture(t);
	processedItems(f);
	inProject(f, "shop");
	const edits = w.request(f.directory, "edits", {
		journal: f.file,
		edits: {
			version: 1,
			items: { "c1-copy": { title: "FAIL the total" } },
			added: [],
		},
	});
	assert.equal(w.command(["save-items", edits]).status, 0);
	const mixed = JSON.parse(
		w.command([
			"file",
			w.request(f.directory, "mixed", {
				journal: f.file,
				keys: ["c1-clipped", "c1-copy"],
			}),
		]).stdout,
	);
	assert.deepEqual(
		mixed.filed.map((item) => item.key),
		["c1-clipped"],
	);
	assert.equal(mixed.failed[0].key, "c1-copy");
	assert.match(mixed.failed[0].error, /bd refused FAIL the total/);

	const empty = w.command([
		"file",
		w.request(f.directory, "empty", { journal: f.file, keys: [] }),
	]);
	assert.equal(empty.status, 1);
	assert.match(empty.stderr, /Choose the items to file/);

	inProject(f, "plain");
	const none = w.command([
		"file",
		w.request(f.directory, "none", { journal: f.file, keys: ["c1-copy"] }),
	]);
	assert.equal(none.status, 1);
	assert.match(none.stderr, /no project with a tracker/);
	assert.equal(w.created().length, 1);
});

test("glossary suggestions are listed, accepted into the project glossary and rejected", (t) => {
	const w = trackerWorld(t);
	const f = fixture(t);
	processedItems(f);
	inProject(f, "shop");
	const suggestion = (term, wrongs) => ({
		term,
		wrongs,
		source: "fixer",
		evidence: { chapter: 1, when: "00:04", said: `the ${wrongs[0]} page` },
		status: "pending",
	});
	fs.writeFileSync(
		path.join(f.directory, "glossary-suggestions.json"),
		JSON.stringify({
			version: 1,
			suggestions: [
				suggestion("Stripe", ["stripey"]),
				suggestion("Klarna", ["clarna"]),
				suggestion("Adyen", ["a yen"]),
			],
		}),
	);
	const listed = JSON.parse(w.command(["glossary-suggestions", f.file]).stdout);
	assert.equal(listed.acceptTarget, w.glossary);
	assert.deepEqual(
		listed.suggestions.map((s) => [s.term, s.status]),
		[
			["Stripe", "pending"],
			["Klarna", "pending"],
			["Adyen", "pending"],
		],
	);
	assert.equal(listed.suggestions[0].evidence.said, "the stripey page");

	const accepted = w.command([
		"glossary-accept",
		w.request(f.directory, "accept", { journal: f.file, terms: ["Stripe"] }),
	]);
	assert.equal(accepted.status, 0, accepted.stderr);
	assert.deepEqual(JSON.parse(accepted.stdout).accepted, ["Stripe"]);
	assert.match(fs.readFileSync(w.glossary, "utf8"), /^Stripe: stripey$/m);

	const rejected = JSON.parse(
		w.command([
			"glossary-reject",
			w.request(f.directory, "reject", { journal: f.file, terms: ["Klarna"] }),
		]).stdout,
	);
	assert.deepEqual(rejected.rejected, ["Klarna"]);

	const rest = JSON.parse(
		w.command([
			"glossary-accept",
			w.request(f.directory, "all", { journal: f.file, terms: "all" }),
		]).stdout,
	);
	assert.deepEqual(rest.accepted, ["Adyen"]);
	assert.deepEqual(
		rest.suggestions.map((s) => [s.term, s.status]),
		[
			["Stripe", "accepted"],
			["Klarna", "rejected"],
			["Adyen", "accepted"],
		],
	);
	const glossary = fs.readFileSync(w.glossary, "utf8");
	assert.doesNotMatch(glossary, /Klarna/);
	assert.match(glossary, /^Adyen: a yen$/m);

	const nothing = w.command([
		"glossary-accept",
		w.request(f.directory, "nothing", { journal: f.file, terms: [] }),
	]);
	assert.equal(nothing.status, 1);
});

test("handoff-ask and the agent prompt name the project's tracker only when it has one", (t) => {
	const w = trackerWorld(t);
	const f = diatribeFixture(t);
	processedItems(f, "diatribe");
	const cfg = { configDir: w.config };
	const bare = JSON.parse(w.command(["handoff-ask", f.file]).stdout);
	assert.equal(bare.project, null);
	assert.equal(bare.tracker, null);
	const plain = nativeWalkPrompt(f.file, { cfg });
	assert.match(plain, /^Turn the action items into beads \(or issues\)/);
	assert.doesNotMatch(plain, / file '.*' --keys/);
	assert.match(plain, / items '.*' --json/);

	inProject(f, "shop");
	const ask = JSON.parse(w.command(["handoff-ask", f.file]).stdout);
	assert.deepEqual(ask.project, { id: "shop", name: "Shop" });
	assert.equal(ask.tracker.label, "beads (shop repo)");
	const prompt = nativeWalkPrompt(f.file, { cfg });
	assert.match(prompt, /^File the action items in beads \(shop repo\) from/);
	assert.match(prompt, /project "Shop" files to beads \(shop repo\)/);
	assert.ok(prompt.includes(`file '${f.directory}' --keys <key,...>`), prompt);
	assert.match(prompt, / items '.*' --json/, "keeps the items guidance");

	const walk = fixture(t);
	processedItems(walk);
	assert.doesNotMatch(nativeWalkPrompt(walk.file, { cfg }), /files to/);
	inProject(walk, "shop");
	const walkPrompt = nativeWalkPrompt(walk.file, { cfg });
	assert.match(walkPrompt, /^Review this /);
	assert.match(walkPrompt, /files to beads \(shop repo\)/);
	inProject(walk, "plain");
	assert.doesNotMatch(nativeWalkPrompt(walk.file, { cfg }), /files to/);
});

test("assign-project moves a recording between projects and out of them", (t) => {
	const w = trackerWorld(t);
	const f = fixture(t);
	processedItems(f);
	fs.writeFileSync(w.glossary, "Stripe: stripey\n");
	const moved = w.command([
		"assign-project",
		w.request(f.directory, "assign", { journal: f.file, project: "shop" }),
	]);
	assert.equal(moved.status, 0, moved.stderr);
	assert.equal(JSON.parse(moved.stdout).tracker.provider, "beads");
	const session = JSON.parse(
		fs.readFileSync(path.join(f.directory, "session.json"), "utf8"),
	);
	assert.equal(session.project, "shop");
	assert.deepEqual(session.glossaries, [w.glossary]);
	const chapter = JSON.parse(
		fs.readFileSync(path.join(f.directory, "01-intro/chapter.json"), "utf8"),
	);
	assert.equal(chapter.project, "shop");

	const missing = w.command([
		"assign-project",
		w.request(f.directory, "missing", { journal: f.file, project: "nope" }),
	]);
	assert.equal(missing.status, 1);
	assert.match(missing.stderr, /No project "nope"/);

	const cleared = JSON.parse(
		w.command([
			"assign-project",
			w.request(f.directory, "clear", { journal: f.file, project: null }),
		]).stdout,
	);
	assert.equal(cleared.project, null);
	assert.equal(
		JSON.parse(fs.readFileSync(path.join(f.directory, "session.json"), "utf8"))
			.project,
		null,
	);
});
