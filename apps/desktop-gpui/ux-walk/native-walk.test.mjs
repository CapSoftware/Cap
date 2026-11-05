import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
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
