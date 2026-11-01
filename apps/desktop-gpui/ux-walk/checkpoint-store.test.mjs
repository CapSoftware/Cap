import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CheckpointStore, completeJsonlPrefix } from "./checkpoint-store.mjs";

function fixture(t) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "ux-walk-checkpoints-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	return {
		root,
		options: {
			recordingId: "11111111-1111-4111-8111-111111111111",
			generation: "22222222-2222-4222-8222-222222222222",
			endpoint: "https://synthetic.example",
		},
	};
}

test("durable descriptors survive a missing mutable cursor and retain unacknowledged data", (t) => {
	const f = fixture(t);
	const store = new CheckpointStore(f.root, f.options);
	const object = store.put("events", Buffer.from('{"ev":"click"}\n'), {
		activeStartMs: 0,
		activeEndMs: 1000,
	});
	const checkpoint = store.commit([object], {
		wallMs: 100000,
		activeElapsedMs: 1000,
		paused: false,
	});
	fs.unlinkSync(path.join(store.root, "state.json"));
	const resumed = new CheckpointStore(f.root, f.options);
	assert.equal(resumed.state.sequence, 1);
	assert.equal(resumed.state.remoteSequence, 0);
	assert.deepEqual(
		resumed.pending().map((item) => item.sequence),
		[checkpoint.sequence],
	);
	resumed.acknowledge(1, f.options.endpoint);
	assert.equal(new CheckpointStore(f.root, f.options).state.remoteSequence, 1);
});

test("content mutation, unsupported objects and server changes never advance acknowledged coverage", (t) => {
	const f = fixture(t);
	const store = new CheckpointStore(f.root, f.options);
	assert.throws(
		() => store.put("authFile", Buffer.from("private"), {}),
		/kind/,
	);
	const object = store.put("journal", Buffer.from("{}"), {
		activeStartMs: 0,
		activeEndMs: 1000,
	});
	fs.writeFileSync(store.objectPath(object.sha256), "corrupt");
	assert.throws(
		() =>
			store.commit([object], {
				wallMs: 1000,
				activeElapsedMs: 1000,
				paused: false,
			}),
		/checksum|integrity/,
	);
	assert.equal(store.state.sequence, 0);
	assert.throws(
		() => store.acknowledge(1, "https://other.example"),
		/server|endpoint/,
	);
	assert.equal(store.state.remoteSequence, 0);
});

test("incomplete JSONL tails remain unread and do not move the event cursor", (t) => {
	const f = fixture(t);
	const file = path.join(f.root, "events.jsonl");
	fs.writeFileSync(file, '{"ev":"click"}\n{"ev":"error"');
	const first = completeJsonlPrefix(file, 0);
	assert.equal(first.bytes.toString(), '{"ev":"click"}\n');
	fs.appendFileSync(file, "}\n");
	assert.equal(
		completeJsonlPrefix(file, first.end).bytes.toString(),
		'{"ev":"error"}\n',
	);
});

test("an equal clock commits and a smaller one is refused without advancing", (t) => {
	const f = fixture(t);
	const store = new CheckpointStore(f.root, f.options);
	const clock = (activeElapsedMs) => ({
		wallMs: 1000,
		activeElapsedMs,
		paused: false,
	});
	store.commit([], clock(1000));
	store.commit([], clock(1000));
	assert.equal(store.state.sequence, 2);
	assert.throws(() => store.commit([], clock(999)), /moved backwards/);
	assert.equal(store.state.sequence, 2);
	assert.equal(store.state.localClockThroughMs, 1000);
});
