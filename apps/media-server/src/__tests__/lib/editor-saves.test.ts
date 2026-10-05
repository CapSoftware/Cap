import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import app from "../../editor-worker-app";
import {
	reportEditorExport,
	uploadEditorExport,
} from "../../lib/editor-exports";

const secret = "editor-save-test-secret";
process.env.MEDIA_SERVER_WEBHOOK_SECRET = secret;
const root = await mkdtemp(join(tmpdir(), "cap-editor-save-"));

afterAll(() => rm(root, { recursive: true, force: true }));

test("a rendered Save is uploaded whole to its presigned URL", async () => {
	const path = join(root, "export.mp4");
	await writeFile(path, new Uint8Array(4096).fill(7));
	const requests: Array<{ url: string; init: RequestInit; body: number }> = [];
	await uploadEditorExport(
		"https://bucket.example/result.mp4?X-Amz-Signature=1",
		path,
		4096,
		(async (url: string, init: RequestInit) => {
			const body = await new Response(init.body).arrayBuffer();
			requests.push({ url, init, body: body.byteLength });
			return new Response(null, { status: 200 });
		}) as unknown as typeof fetch,
	);
	expect(requests).toHaveLength(1);
	expect(requests[0]?.init.method).toBe("PUT");
	expect(requests[0]?.body).toBe(4096);
	expect(new Headers(requests[0]?.init.headers).get("content-length")).toBe(
		"4096",
	);
	await expect(
		uploadEditorExport(
			"https://bucket.example/result.mp4",
			path,
			4096,
			(async () =>
				new Response(null, { status: 403 })) as unknown as typeof fetch,
		),
	).rejects.toThrow("Save upload failed with 403");
});

test("a Save's callback carries the worker secret and retries until the web app answers", async () => {
	let calls = 0;
	const seen: Headers[] = [];
	const accepted = await reportEditorExport(
		"https://cap.example/api/editor/worker-saves/callback",
		{ status: "published" },
		(async (_url: string, init: RequestInit) => {
			seen.push(new Headers(init.headers));
			calls++;
			if (calls < 3) return new Response(null, { status: 503 });
			return Response.json({ ok: true });
		}) as unknown as typeof fetch,
		1,
	);
	expect(accepted).toBe(true);
	expect(calls).toBe(3);
	expect(
		seen.every((headers) => headers.get("x-media-server-secret") === secret),
	).toBe(true);
	expect(
		await reportEditorExport(
			"https://cap.example/callback",
			{},
			(async () =>
				new Response(null, { status: 409 })) as unknown as typeof fetch,
			1,
		),
	).toBe(false);
});

test("the Save route rejects requests without the secret, bad targets and unknown sessions", async () => {
	const request = (body: unknown, headers: Record<string, string> = {}) =>
		app.request("/editor/sessions/missing/saves", {
			method: "POST",
			headers: { "Content-Type": "application/json", ...headers },
			body: JSON.stringify(body),
		});
	const save = {
		settings: {
			format: "Mp4",
			fps: 30,
			resolution_base: { x: 1920, y: 1080 },
			compression: "Maximum",
			custom_bpp: null,
		},
		uploadUrl: "https://bucket.example/result.mp4",
		callbackUrl: "https://cap.example/api/editor/worker-saves/callback",
		videoId: "video",
		saveId: "8c1f4d39-6d2c-4b1a-9e0b-0b2f6f5f3a11",
	};
	expect((await request(save)).status).toBe(401);
	const authed = { "x-media-server-secret": secret };
	expect(
		(await request({ ...save, uploadUrl: "http://bucket.example/x" }, authed))
			.status,
	).toBe(400);
	expect(
		(
			await request(
				{
					...save,
					settings: { ...save.settings, format: "Gif", quality: null },
				},
				authed,
			)
		).status,
	).toBe(400);
	expect((await request(save, authed)).status).toBe(404);
	const status = await app.request("/editor/sessions/missing/saves/unknown", {
		headers: authed,
	});
	expect(status.status).toBe(404);
});
