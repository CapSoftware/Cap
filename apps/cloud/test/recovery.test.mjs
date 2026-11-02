import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";

const token = "synthetic-recovery-owner-token-with-32-bytes";
const headers = { Authorization: `Bearer ${token}` };
let runtime;
before(() => {
	runtime = new Miniflare(
		convertV4MiniflareOptions({
			name: "recovery-test",
			modules: true,
			scriptPath: fileURLToPath(new URL("../dist/index.js", import.meta.url)),
			compatibilityDate: "2026-10-25",
			r2Buckets: ["MEDIA"],
			bindings: { UPLOAD_TOKEN: token },
		}),
	);
});
after(async () => runtime?.dispose());
const request = (path, init = {}) =>
	runtime.dispatchFetch(`https://recovery.test/api/v1/recovery${path}`, init);
const digest = (body) => createHash("sha256").update(body).digest("hex");
async function register() {
	const id = randomUUID();
	const registration = {
		schemaVersion: 1,
		recordingId: id,
		writerGeneration: randomUUID(),
		title: "Synthetic interrupted walk",
		startedAtMs: 1000,
		expiresInDays: 7,
	};
	const result = await request(`/${id}`, {
		method: "PUT",
		headers,
		body: JSON.stringify(registration),
	});
	assert.equal(result.status, 201, await result.clone().text());
	return registration;
}

test("every recovery route requires owner authentication, never a viewer cookie", async () => {
	const id = randomUUID();
	for (const [method, suffix] of [
		["GET", ""],
		["PUT", `/${id}`],
		["GET", `/${id}`],
		["DELETE", `/${id}`],
		["PUT", `/${id}/objects/${"a".repeat(64)}`],
		["GET", `/${id}/objects/${"a".repeat(64)}`],
		["PUT", `/${id}/checkpoints/1`],
	]) {
		assert.equal(
			(
				await request(suffix, {
					method,
					headers: { Cookie: `capux_read=${token}` },
				})
			).status,
			401,
		);
	}
});

test("immutable objects and checkpoints survive identical retries and reject corruption/conflicts", async () => {
	const registration = await register();
	const id = registration.recordingId;
	const bytes = Buffer.from('{"ev":"click","observedAt":1000}\n');
	const hash = digest(bytes);
	const objectRoute = `/${id}/objects/${hash}`;
	assert.equal(
		(
			await request(objectRoute, {
				method: "PUT",
				headers,
				body: "wrong bytes",
			})
		).status,
		400,
	);
	for (let i = 0; i < 2; i++)
		assert.equal(
			(await request(objectRoute, { method: "PUT", headers, body: bytes }))
				.status,
			200,
		);
	const checkpoint = {
		schemaVersion: 1,
		recordingId: id,
		writerGeneration: registration.writerGeneration,
		sequence: 1,
		previousSequence: 0,
		activeThroughMs: 1000,
		clock: { wallMs: 2000, activeElapsedMs: 1000, paused: false },
		objects: [
			{
				kind: "events",
				sha256: hash,
				size: bytes.length,
				activeStartMs: 0,
				activeEndMs: 1000,
			},
		],
	};
	for (let i = 0; i < 2; i++)
		assert.equal(
			(
				await request(`/${id}/checkpoints/1`, {
					method: "PUT",
					headers,
					body: JSON.stringify(checkpoint),
				})
			).status,
			200,
		);
	assert.equal(
		(
			await request(`/${id}/checkpoints/1`, {
				method: "PUT",
				headers,
				body: JSON.stringify({ ...checkpoint, activeThroughMs: 2000 }),
			})
		).status,
		409,
	);
	assert.equal(
		await (await request(objectRoute, { headers })).text(),
		bytes.toString(),
	);
	const restored = await (await request(`/${id}`, { headers })).json();
	assert.equal(restored.checkpoints.length, 1);
	assert.equal(restored.checkpoints[0].objects[0].sha256, hash);
	assert.equal((await request(objectRoute)).status, 401);
	assert.equal((await request(`/s/${id}`)).status, 401);
});

test("a descriptor never acknowledges missing data and tombstones forbid later publication", async () => {
	const registration = await register();
	const id = registration.recordingId;
	const checkpoint = {
		schemaVersion: 1,
		recordingId: id,
		writerGeneration: registration.writerGeneration,
		sequence: 1,
		previousSequence: 0,
		activeThroughMs: 1000,
		clock: { wallMs: 2000, activeElapsedMs: 1000, paused: false },
		objects: [
			{
				kind: "microphone",
				source: "segment-0:microphone",
				sha256: "a".repeat(64),
				size: 42,
				activeStartMs: 0,
				activeEndMs: 1000,
			},
		],
	};
	assert.equal(
		(
			await request(`/${id}/checkpoints/1`, {
				method: "PUT",
				headers,
				body: JSON.stringify(checkpoint),
			})
		).status,
		409,
	);
	assert.equal(
		(await request(`/${id}`, { method: "DELETE", headers })).status,
		204,
	);
	assert.equal(
		(await request(`/${id}`, { method: "DELETE", headers })).status,
		204,
	);
	assert.equal((await request(`/${id}`, { headers })).status, 404);
	assert.equal(
		(
			await request(`/${id}`, {
				method: "PUT",
				headers,
				body: JSON.stringify(registration),
			})
		).status,
		404,
	);
	assert.equal(
		(
			await request(`/${id}/checkpoints/1`, {
				method: "PUT",
				headers,
				body: JSON.stringify(checkpoint),
			})
		).status,
		404,
	);
});

test("checkpoint coverage rejects reversed or future ranges and active clock regression", async () => {
	for (const range of [
		{ activeStartMs: -1, activeEndMs: 1000 },
		{ activeStartMs: 1000, activeEndMs: 0 },
		{ activeStartMs: 0, activeEndMs: 1001 },
		{ activeStartMs: "0", activeEndMs: 1000 },
	]) {
		const registration = await register();
		const id = registration.recordingId;
		const bytes = Buffer.from("synthetic");
		const hash = digest(bytes);
		await request(`/${id}/objects/${hash}`, {
			method: "PUT",
			headers,
			body: bytes,
		});
		const checkpoint = {
			schemaVersion: 1,
			recordingId: id,
			writerGeneration: registration.writerGeneration,
			sequence: 1,
			previousSequence: 0,
			activeThroughMs: 1000,
			clock: { wallMs: 2000, activeElapsedMs: 1000, paused: false },
			objects: [{ kind: "events", sha256: hash, size: bytes.length, ...range }],
		};
		assert.equal(
			(
				await request(`/${id}/checkpoints/1`, {
					method: "PUT",
					headers,
					body: JSON.stringify(checkpoint),
				})
			).status,
			400,
		);
	}
	const registration = await register();
	const id = registration.recordingId;
	const checkpoint = {
		schemaVersion: 1,
		recordingId: id,
		writerGeneration: registration.writerGeneration,
		sequence: 1,
		previousSequence: 0,
		activeThroughMs: 1000,
		clock: { wallMs: 2000, activeElapsedMs: 1000, paused: false },
		objects: [],
	};
	assert.equal(
		(
			await request(`/${id}/checkpoints/1`, {
				method: "PUT",
				headers,
				body: JSON.stringify(checkpoint),
			})
		).status,
		200,
	);
	assert.equal(
		(
			await request(`/${id}/checkpoints/2`, {
				method: "PUT",
				headers,
				body: JSON.stringify({
					...checkpoint,
					sequence: 2,
					previousSequence: 1,
					activeThroughMs: 999,
					clock: { ...checkpoint.clock, activeElapsedMs: 999 },
				}),
			})
		).status,
		400,
	);
	assert.equal(
		(
			await request(`/${id}/checkpoints/2`, {
				method: "PUT",
				headers,
				body: JSON.stringify({
					...checkpoint,
					sequence: 2,
					previousSequence: 1,
					clock: { ...checkpoint.clock, wallMs: 1999 },
				}),
			})
		).status,
		200,
	);
});

test("acknowledged recovery descriptors remain retrievable within the client response budget", async () => {
	const registration = await register();
	const id = registration.recordingId;
	for (let sequence = 1; sequence <= 35; sequence++) {
		const descriptor = {
			schemaVersion: 1,
			recordingId: id,
			writerGeneration: registration.writerGeneration,
			sequence,
			previousSequence: sequence - 1,
			activeThroughMs: 1000,
			clock: { wallMs: 2000, activeElapsedMs: 1000, paused: false },
			objects: [],
			padding: "x".repeat(245000),
		};
		assert.equal(
			(
				await request(`/${id}/checkpoints/${sequence}`, {
					method: "PUT",
					headers,
					body: JSON.stringify(descriptor),
				})
			).status,
			200,
		);
	}
	let cursor;
	let count = 0;
	do {
		const response = await request(
			`/${id}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
			{ headers },
		);
		const text = await response.text();
		assert.ok(Buffer.byteLength(text) <= 8 * 1024 * 1024);
		const page = JSON.parse(text);
		count += page.checkpoints.length;
		cursor = page.cursor;
	} while (cursor);
	assert.equal(count, 35);
});
