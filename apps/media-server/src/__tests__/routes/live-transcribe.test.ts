import { afterAll, describe, expect, test } from "bun:test";
import app from "../../app";
import { setDraining } from "../../lib/lifecycle";

const SECRET = "test-secret";
process.env.MEDIA_SERVER_WEBHOOK_SECRET = SECRET;

const reports: Record<string, unknown>[] = [];
let reported: () => void = () => {};
const firstReport = new Promise<void>((resolve) => {
	reported = resolve;
});
const server = Bun.serve({
	port: 0,
	async fetch(request) {
		const path = new URL(request.url).pathname;
		if (path === "/manifest") {
			return Response.json({
				audio_init_uploaded: false,
				audio_segments: [],
				is_complete: true,
			});
		}
		if (path === "/report") {
			reports.push(await request.json());
			reported();
			return Response.json({ continue: false });
		}
		return new Response(null, { status: 404 });
	},
});
afterAll(() => server.stop(true));

const base = `http://127.0.0.1:${server.port}`;
const body = {
	videoId: "video1",
	session: "s1",
	callbackUrl: `${base}/report`,
	asr: { baseUrl: `${base}/asr`, apiKey: "k" },
	contextSeconds: 20,
	state: {
		lastAudioSegmentIndex: -1,
		transcribedDurationMs: 0,
		transcriptionOptions: {},
		urls: {
			manifest: `${base}/manifest`,
			audioInit: `${base}/init`,
			segments: { "0": `${base}/0` },
		},
	},
};

const post = (payload: unknown, secret: string | null = SECRET) =>
	app.fetch(
		new Request("http://localhost/live-transcribe/sessions", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...(secret ? { "x-media-server-secret": secret } : {}),
			},
			body: JSON.stringify(payload),
		}),
	);

describe("POST /live-transcribe/sessions", () => {
	test("rejects requests without the secret or with a bad body", async () => {
		expect((await post(body, null)).status).toBe(401);
		expect((await post(body, "wrong")).status).toBe(401);
		expect((await post({ ...body, callbackUrl: "nope" })).status).toBe(400);
		expect((await post({ ...body, contextSeconds: 600 })).status).toBe(400);
	});

	test("refuses new sessions while draining", async () => {
		setDraining(true);
		try {
			const response = await post(body);
			expect(response.status).toBe(503);
			expect(response.headers.get("Retry-After")).toBeTruthy();
		} finally {
			setDraining(false);
		}
	});

	test("starts a session that reports back to the web app", async () => {
		const response = await post(body);
		expect(response.status).toBe(202);
		await firstReport;
		expect(reports).toEqual([
			{
				action: "finish",
				outcome: "no-audio",
				videoId: "video1",
				session: "s1",
			},
		]);
		await Bun.sleep(20);
		const status = await app.fetch(
			new Request("http://localhost/live-transcribe/status"),
		);
		expect(await status.json()).toEqual({
			sessions: 0,
			canAcceptNewSession: true,
		});
	});
});
