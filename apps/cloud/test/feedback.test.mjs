import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";

const token = "synthetic-feedback-owner-token-with-32-bytes";
const owner = { Authorization: `Bearer ${token}` };
const APP = "https://app.example.test";
const OTHER = "https://other.example.test";
const KEY = "wf_pub_demo_site_key_1";
const OTHER_KEY = "wf_pub_other_site_key_2";
const sites = {
	[KEY]: { name: "Demo clinic", origins: [APP], retentionDays: 7 },
	[OTHER_KEY]: { name: "Other", origins: [OTHER] },
};
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6]);
const webm = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 9, 8, 7, 6]);
let runtime;
let limited;

function start(overrides = {}) {
	return new Miniflare(
		convertV4MiniflareOptions({
			name: "feedback-test",
			modules: true,
			scriptPath: fileURLToPath(new URL("../dist/index.js", import.meta.url)),
			compatibilityDate: "2026-10-25",
			r2Buckets: ["MEDIA"],
			ratelimits: {
				FEEDBACK_LIMIT: {
					namespace_id: "1",
					simple: { limit: 1000, period: 60 },
				},
				FEEDBACK_SITE_LIMIT: {
					namespace_id: "2",
					simple: { limit: 1000, period: 60 },
				},
			},
			bindings: { UPLOAD_TOKEN: token, FEEDBACK_SITES: JSON.stringify(sites) },
			...overrides,
		}),
	);
}
before(() => {
	runtime = start();
	limited = start({
		ratelimits: {
			FEEDBACK_LIMIT: { namespace_id: "1", simple: { limit: 2, period: 60 } },
			FEEDBACK_SITE_LIMIT: {
				namespace_id: "2",
				simple: { limit: 1000, period: 60 },
			},
		},
	});
});
after(async () => {
	await runtime?.dispose();
	await limited?.dispose();
});

const evidence = (extra = {}) =>
	JSON.stringify({
		schemaVersion: 1,
		capturedAt: Date.now(),
		route: "/patients/:id?mrn=1",
		events: [
			{
				t: 1,
				ev: "click",
				url: "/patients/:id?x=1",
				el: { tag: "button", text: "Save" },
			},
			{
				t: 2,
				ev: "write",
				url: "/p",
				method: "POST",
				request: "/api/save?token=abc",
				status: 409,
				requestId: "req-1",
			},
		],
		posthog: {
			sessionId: "ph-1",
			replayUrl: "https://us.posthog.com/replay/ph-1",
		},
		...extra,
	});

function form({
	key = KEY,
	note = "Saving fails",
	screenshot = jpeg,
	voice = webm,
	evidenceText = evidence(),
	types = {},
} = {}) {
	const body = new FormData();
	if (key !== null) body.set("key", key);
	if (note !== null) body.set("note", note);
	if (evidenceText !== null) body.set("evidence", evidenceText);
	if (screenshot)
		body.set(
			"screenshot",
			new Blob([screenshot], { type: types.screenshot ?? "image/jpeg" }),
			"s.jpg",
		);
	if (voice)
		body.set(
			"voice",
			new Blob([voice], { type: types.voice ?? "audio/webm" }),
			"v.webm",
		);
	return body;
}

async function post(body, origin = APP, target = runtime, headers = {}) {
	const encoded = new Request("https://worm.test/", { method: "POST", body });
	return target.dispatchFetch("https://worm.test/api/v1/feedback", {
		method: "POST",
		body: Buffer.from(await encoded.arrayBuffer()),
		headers: {
			"Content-Type": encoded.headers.get("Content-Type"),
			...(origin ? { Origin: origin } : {}),
			...headers,
		},
	});
}
const get = (path, headers = owner) =>
	runtime.dispatchFetch(`https://worm.test/api/v1/feedback${path}`, {
		headers,
	});

test("only listed origins can send, and only with their own site key", async () => {
	const preflight = await runtime.dispatchFetch(
		"https://worm.test/api/v1/feedback",
		{
			method: "OPTIONS",
			headers: { Origin: APP, "Access-Control-Request-Method": "POST" },
		},
	);
	assert.equal(preflight.status, 204);
	assert.equal(preflight.headers.get("Access-Control-Allow-Origin"), APP);

	for (const origin of [
		null,
		"https://evil.example.test",
		"http://app.example.test",
	]) {
		const result = await post(form(), origin);
		assert.equal(result.status, 403, String(origin));
		assert.equal(result.headers.get("Access-Control-Allow-Origin"), null);
	}
	const crossed = await post(form({ key: OTHER_KEY }));
	assert.equal(crossed.status, 403);
	assert.equal(crossed.headers.get("Access-Control-Allow-Origin"), APP);
	assert.equal(
		(await post(form({ key: "wf_pub_unknown_key_123" }))).status,
		403,
	);
	assert.equal((await post(form({ key: null }))).status, 403);
});

test("a report is stored privately and only the owner can list, read and delete it", async () => {
	const created = await post(form());
	assert.equal(created.status, 201, await created.clone().text());
	assert.equal(created.headers.get("Access-Control-Allow-Origin"), APP);
	assert.equal(created.headers.get("Cache-Control"), "private, no-store");
	const { id } = await created.json();
	assert.match(id, /^\d{13}-[a-f0-9]{16}$/);

	for (const path of ["", `/${id}`, `/${id}/screenshot`, `/${id}/voice`]) {
		assert.equal((await get(path, {})).status, 401, path);
		assert.equal(
			(await get(path, { Cookie: `capux_read=${token}` })).status,
			401,
			path,
		);
		assert.equal(
			(
				await get(path, {
					Authorization: "Bearer wrong-token-of-sufficient-length-000",
				})
			).status,
			401,
			path,
		);
	}
	assert.equal(
		(
			await runtime.dispatchFetch(`https://worm.test/api/v1/feedback/${id}`, {
				method: "DELETE",
				headers: { Origin: APP },
			})
		).status,
		401,
	);

	const listed = await (await get("")).json();
	const entry = listed.reports.find((report) => report.id === id);
	assert.deepEqual(
		{
			site: entry.site,
			route: entry.route,
			preview: entry.preview,
			screenshot: entry.screenshot,
			voice: entry.voice,
		},
		{
			site: "Demo clinic",
			route: "/patients/:id",
			preview: "Saving fails",
			screenshot: true,
			voice: true,
		},
	);

	const report = await (await get(`/${id}`)).json();
	assert.equal(report.origin, APP);
	assert.equal(report.note, "Saving fails");
	assert.equal(report.evidence.route, "/patients/:id");
	assert.equal(report.evidence.events[0].url, "/patients/:id");
	assert.equal(report.evidence.events[1].request, "/api/save");
	assert.equal(report.evidence.posthog.sessionId, "ph-1");
	assert.ok(report.expiresAt - report.createdAt === 7 * 86400000);
	assert.equal(
		report.screenshot.sha256,
		createHash("sha256").update(jpeg).digest("hex"),
	);

	const shot = await get(`/${id}/screenshot`);
	assert.equal(shot.headers.get("Content-Type"), "image/jpeg");
	assert.equal(shot.headers.get("Content-Disposition"), "attachment");
	assert.deepEqual(Buffer.from(await shot.arrayBuffer()), jpeg);
	const voice = await get(`/${id}/voice`);
	assert.equal(voice.headers.get("Content-Type"), "audio/webm");
	assert.deepEqual(Buffer.from(await voice.arrayBuffer()), webm);

	const removed = await runtime.dispatchFetch(
		`https://worm.test/api/v1/feedback/${id}`,
		{ method: "DELETE", headers: owner },
	);
	assert.equal(removed.status, 204);
	for (const path of [`/${id}`, `/${id}/screenshot`, `/${id}/voice`])
		assert.equal((await get(path)).status, 404, path);
	assert.ok(
		!(await (await get("")).json()).reports.some((item) => item.id === id),
	);
});

test("reports without media or with only a voice memo are accepted", async () => {
	assert.equal(
		(await post(form({ screenshot: null, voice: null }))).status,
		201,
	);
	assert.equal((await post(form({ note: "", screenshot: null }))).status, 201);
	assert.equal(
		(await post(form({ note: "  ", screenshot: null, voice: null }))).status,
		400,
	);
});

test("limits on size, format and evidence are enforced", async () => {
	assert.equal((await post(form({ note: "x".repeat(4001) }))).status, 400);
	assert.equal(
		(
			await post(
				form({
					screenshot: Buffer.concat([jpeg, Buffer.alloc(4 * 1024 * 1024)]),
				}),
			)
		).status,
		413,
	);
	assert.equal(
		(await post(form({ screenshot: Buffer.from("<html><script>") }))).status,
		415,
	);
	assert.equal(
		(await post(form({ types: { screenshot: "text/html" } }))).status,
		415,
	);
	assert.equal(
		(
			await post(
				form({
					voice: Buffer.from("not audio"),
					types: { voice: "audio/webm" },
				}),
			)
		).status,
		415,
	);
	assert.equal((await post(form({ evidenceText: "not json" }))).status, 400);
	assert.equal((await post(form({ evidenceText: null }))).status, 400);
	assert.equal(
		(await post(form({ evidenceText: evidence({ schemaVersion: 2 }) }))).status,
		400,
	);
	assert.equal(
		(
			await post(
				form({
					evidenceText: evidence({
						events: Array.from({ length: 201 }, (_, t) => ({ t, ev: "click" })),
					}),
				}),
			)
		).status,
		400,
	);
	assert.equal(
		(await post(form({ evidenceText: "x".repeat(256 * 1024 + 1) }))).status,
		400,
	);
	assert.equal(
		(
			await post(
				form({ voice: Buffer.concat([webm, Buffer.alloc(7 * 1024 * 1024)]) }),
			)
		).status,
		413,
	);
	const huge = await post(
		form({ voice: Buffer.concat([webm, Buffer.alloc(13 * 1024 * 1024)]) }),
	).catch((error) => error);
	// The Worker refuses on Content-Length before reading, so the client can see the
	// connection close mid-upload instead of the 413.
	if (huge instanceof Error)
		assert.match(
			`${huge.message} ${huge.cause?.code ?? ""}`,
			/EPIPE|ECONNRESET|fetch failed/,
		);
	else assert.equal(huge.status, 413);
	const plain = await runtime.dispatchFetch(
		"https://worm.test/api/v1/feedback",
		{
			method: "POST",
			body: JSON.stringify({ key: KEY, note: "hi" }),
			headers: { Origin: APP, "Content-Type": "application/json" },
		},
	);
	assert.equal(plain.status, 415);
});

test("a browser that floods a site is rate limited", async () => {
	const headers = { "CF-Connecting-IP": "203.0.113.9" };
	assert.equal((await post(form(), APP, limited, headers)).status, 201);
	assert.equal((await post(form(), APP, limited, headers)).status, 201);
	const blocked = await post(form(), APP, limited, headers);
	assert.equal(blocked.status, 429);
	assert.equal(blocked.headers.get("Access-Control-Allow-Origin"), APP);
	assert.equal(
		(await post(form(), APP, limited, { "CF-Connecting-IP": "203.0.113.10" }))
			.status,
		201,
	);
});

test("misconfigured or missing sites never accept feedback", async () => {
	const bare = start({ bindings: { UPLOAD_TOKEN: token } });
	try {
		assert.equal((await post(form(), APP, bare)).status, 403);
	} finally {
		await bare.dispose();
	}
	const broken = start({
		bindings: {
			UPLOAD_TOKEN: token,
			FEEDBACK_SITES: JSON.stringify({
				short: { origins: ["http://app.example.test"] },
			}),
		},
	});
	try {
		assert.equal(
			(await post(form(), "http://app.example.test", broken)).status,
			503,
		);
	} finally {
		await broken.dispose();
	}
});

test("unknown ids and methods are refused", async () => {
	assert.equal((await get("/../shares")).status, 404);
	assert.equal((await get("/not-an-id")).status, 404);
	assert.equal((await get("/0000000000000-0000000000000000")).status, 404);
	assert.equal(
		(
			await runtime.dispatchFetch("https://worm.test/api/v1/feedback", {
				method: "PUT",
				headers: owner,
			})
		).status,
		405,
	);
});
