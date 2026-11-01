import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CheckpointJobs, MISSING_KEY } from "./checkpoint-jobs.mjs";
import { CheckpointStore, durableJson } from "./checkpoint-store.mjs";

test("successful silent jobs complete once and ambiguous submissions require explicit retry", async (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "ux-walk-jobs-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const store = new CheckpointStore(root, {
		recordingId: "11111111-1111-4111-8111-111111111111",
		generation: "22222222-2222-4222-8222-222222222222",
		endpoint: "",
	});
	let calls = 0;
	const jobs = new CheckpointJobs(
		store,
		{ transcriber: "elevenlabs" },
		{
			words: async () => {
				calls++;
				return [];
			},
			materialize: async () => "synthetic.wav",
		},
	);
	const job = jobs.prepare("segment-0:microphone", [], 0, 300000);
	await jobs.runNext();
	await jobs.runNext();
	assert.equal(calls, 1);
	assert.equal(jobs.read(job.jobId).state, "complete");
	const next = jobs.prepare("segment-0:microphone", [], 300000, 600000);
	jobs.words = async () => {
		calls++;
		throw new Error("response lost");
	};
	await jobs.runNext();
	await jobs.runNext();
	assert.equal(calls, 2);
	assert.equal(jobs.read(next.jobId).state, "ambiguous");
	const lost = jobs.prepare("segment-0:microphone", [], 600000, 900000);
	durableJson(jobs.jobPath(lost.jobId), { ...lost, state: "submitted" });
	const resumed = new CheckpointJobs(
		store,
		{ transcriber: "elevenlabs" },
		{ words: jobs.words, materialize: jobs.materialize },
	);
	await resumed.runNext();
	assert.equal(calls, 2);
	assert.equal(resumed.read(lost.jobId).state, "ambiguous");
});

test("ambiguous jobs only retry through a bounded explicit action", async (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "uxw-job-retry-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const store = new CheckpointStore(root, {
		recordingId: "11111111-1111-4111-8111-111111111111",
		generation: "22222222-2222-4222-8222-222222222222",
		endpoint: "",
	});
	let calls = 0;
	const jobs = new CheckpointJobs(
		store,
		{ transcriber: "elevenlabs" },
		{
			materialize: async () => "synthetic.wav",
			words: async () => {
				calls++;
				throw new Error("lost response");
			},
		},
	);
	const job = jobs.prepare("segment-0:microphone", [], 0, 1000);
	await jobs.runNext();
	for (let i = 0; i < 3; i++) {
		jobs.retry(job.jobId);
		await jobs.runNext();
	}
	assert.equal(calls, 4);
	assert.throws(() => jobs.retry(job.jobId), /limit/);
	assert.equal(jobs.read(job.jobId).state, "ambiguous");
});

test("prepared job provenance cannot silently change with provider or language settings", async (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "uxw-options-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const store = new CheckpointStore(root, {
		recordingId: "11111111-1111-4111-8111-111111111111",
		generation: "22222222-2222-4222-8222-222222222222",
		endpoint: "",
	});
	new CheckpointJobs(store, {
		transcriber: "elevenlabs",
		language: "en",
	}).prepare("segment-0:microphone", [], 0, 1000);
	let calls = 0;
	const resumed = new CheckpointJobs(
		store,
		{ transcriber: "assemblyai", language: "es" },
		{
			materialize: async () => "synthetic.wav",
			words: async () => {
				calls++;
				return [];
			},
		},
	);
	await resumed.runNext();
	assert.equal(calls, 0);
	assert.equal(resumed.all()[0].state, "failed");
	assert.match(resumed.all()[0].error, /configuration|options|provider/i);
});

function jobStore(t) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "uxw-job-key-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	return new CheckpointStore(root, {
		recordingId: "11111111-1111-4111-8111-111111111111",
		generation: "22222222-2222-4222-8222-222222222222",
		endpoint: "",
	});
}

test("a job with no key sends nothing, stays retryable, and runs once a key appears", async (t) => {
	const store = jobStore(t);
	let key = false;
	let sent = 0;
	let built = 0;
	const dependencies = {
		hasKey: () => key,
		materialize: async () => {
			built++;
			return "synthetic.wav";
		},
		words: async () => {
			sent++;
			return [];
		},
	};
	const jobs = new CheckpointJobs(
		store,
		{ transcriber: "elevenlabs" },
		dependencies,
	);
	const job = jobs.prepare("segment-0:microphone", [], 0, 1000);
	await jobs.runNext();
	const waiting = jobs.read(job.jobId);
	assert.equal(waiting.state, "failed");
	assert.equal(waiting.notSent, "missing-key");
	assert.equal(waiting.submittedAt, undefined);
	assert.deepEqual([sent, built], [0, 0]);
	key = true;
	await jobs.runNext();
	assert.equal(sent, 0, "the recheck waits for its interval");
	jobs.nextKeyCheckAt = 0;
	await jobs.runNext();
	assert.equal(sent, 1);
	const done = jobs.read(job.jobId);
	assert.equal(done.state, "complete");
	assert.equal(done.manualRetries, undefined);
	assert.equal(done.retryAcknowledgedAt, undefined);
	assert.equal(done.notSent, undefined);
});

test("a key missing at request time is not ambiguous, and the real engine error matches", async (t) => {
	const { providerKey } = await import(
		new URL("../../../vendor/ux-walk/src/transcribe.mjs", import.meta.url)
	);
	const saved = process.env.ASSEMBLYAI_API_KEY;
	t.after(() => {
		if (saved === undefined) delete process.env.ASSEMBLYAI_API_KEY;
		else process.env.ASSEMBLYAI_API_KEY = saved;
	});
	delete process.env.ASSEMBLYAI_API_KEY;
	let message;
	try {
		providerKey({
			transcriber: "assemblyai",
			assemblyaiKeychainItem: "uxw-test-absent-item",
		});
	} catch (error) {
		message = error.message;
	}
	assert.match(message, MISSING_KEY);
	const jobs = new CheckpointJobs(
		jobStore(t),
		{ transcriber: "assemblyai" },
		{
			materialize: async () => "synthetic.wav",
			words: async () => {
				throw new Error(message);
			},
		},
	);
	const job = jobs.prepare("segment-0:microphone", [], 0, 1000);
	await jobs.runNext();
	assert.equal(jobs.read(job.jobId).state, "failed");
	assert.equal(jobs.read(job.jobId).notSent, "missing-key");
});

test("saved missing-key ambiguous jobs are corrected; real ambiguity is not", async (t) => {
	const store = jobStore(t);
	const cfg = { transcriber: "elevenlabs" };
	const first = new CheckpointJobs(store, cfg, { words: async () => [] });
	const noKey = first.prepare("segment-0:microphone", [], 0, 1000);
	const lost = first.prepare("segment-0:microphone", [], 1000, 2000);
	const refused = first.prepare("segment-0:microphone", [], 2000, 3000);
	const crashed = first.prepare("segment-0:microphone", [], 3000, 4000);
	durableJson(first.jobPath(noKey.jobId), {
		...noKey,
		state: "ambiguous",
		error: "no Synthetic key: run setup",
	});
	durableJson(first.jobPath(lost.jobId), {
		...lost,
		state: "ambiguous",
		error: "fetch failed",
	});
	durableJson(first.jobPath(refused.jobId), {
		...refused,
		state: "ambiguous",
		error: "Synthetic 500: no Synthetic key on this tier",
	});
	durableJson(first.jobPath(crashed.jobId), { ...crashed, state: "submitted" });
	let sent = 0;
	const resumed = new CheckpointJobs(store, cfg, {
		materialize: async () => "synthetic.wav",
		words: async () => {
			sent++;
			return [];
		},
	});
	assert.equal(resumed.read(noKey.jobId).state, "failed");
	assert.equal(resumed.read(crashed.jobId).state, "ambiguous");
	await resumed.runNext();
	await resumed.runNext();
	assert.equal(sent, 1);
	assert.equal(resumed.read(noKey.jobId).state, "complete");
	for (const job of [lost, refused, crashed]) {
		assert.equal(resumed.read(job.jobId).state, "ambiguous");
		assert.equal(resumed.read(job.jobId).notSent, undefined);
	}
});

test("a request that may have left stays ambiguous even if its error mentions a key", async (t) => {
	const jobs = new CheckpointJobs(
		jobStore(t),
		{ transcriber: "elevenlabs" },
		{
			materialize: async () => "synthetic.wav",
			words: async () => {
				throw new Error("connection reset after no key echo");
			},
		},
	);
	const job = jobs.prepare("segment-0:microphone", [], 0, 1000);
	await jobs.runNext();
	assert.equal(jobs.read(job.jobId).state, "ambiguous");
	assert.throws(() => {
		jobs.retry(job.jobId);
		jobs.retry(job.jobId);
	}, /Only failed or ambiguous/);
	assert.equal(jobs.read(job.jobId).manualRetries, 1);
});

test("a local failure before submission is not sent and retries without spending a manual retry", async (t) => {
	const store = jobStore(t);
	const cfg = { transcriber: "elevenlabs" };
	let fail = true;
	let sent = 0;
	const dependencies = {
		materialize: async () => {
			if (fail) throw new Error("audio could not be prepared");
			return "synthetic.wav";
		},
		words: async () => {
			sent++;
			return [];
		},
	};
	const jobs = new CheckpointJobs(store, cfg, dependencies);
	const job = jobs.prepare("segment-0:microphone", [], 0, 1000);
	await jobs.runNext();
	assert.equal(jobs.read(job.jobId).notSent, "local");
	await jobs.runNext();
	assert.equal(jobs.read(job.jobId).state, "failed", "no retry loop");
	fail = false;
	const resumed = new CheckpointJobs(store, cfg, dependencies);
	await resumed.runNext();
	assert.equal(sent, 1);
	assert.equal(resumed.read(job.jobId).state, "complete");
	assert.equal(resumed.read(job.jobId).manualRetries, undefined);
});

test("a provider rejection after sending keeps the paid retry limit", async (t) => {
	const jobs = new CheckpointJobs(
		jobStore(t),
		{ transcriber: "elevenlabs" },
		{
			materialize: async () => "synthetic.wav",
			words: async () => {
				throw new Error("Synthetic 401: unauthorized");
			},
		},
	);
	const job = jobs.prepare("segment-0:microphone", [], 0, 1000);
	await jobs.runNext();
	assert.equal(jobs.read(job.jobId).state, "failed");
	assert.equal(jobs.read(job.jobId).notSent, undefined);
	jobs.retry(job.jobId);
	assert.equal(jobs.read(job.jobId).manualRetries, 1);
});
