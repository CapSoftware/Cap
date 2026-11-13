import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	test,
} from "bun:test";
import app from "../../app";
import { mediaServerPeers } from "../../lib/peer-jobs";

const previousPublicStatus = process.env.MEDIA_SERVER_PUBLIC_STATUS;
beforeAll(() => {
	process.env.MEDIA_SERVER_PUBLIC_STATUS = "true";
});
afterAll(() => {
	if (previousPublicStatus === undefined)
		delete process.env.MEDIA_SERVER_PUBLIC_STATUS;
	else process.env.MEDIA_SERVER_PUBLIC_STATUS = previousPublicStatus;
});

const SECRET = "peer-test-secret";
process.env.MEDIA_SERVER_WEBHOOK_SECRET = SECRET;

const peerRequests: {
	method: string;
	peerLookup: string | null;
	secret: string | null;
}[] = [];
let respond: (request: Request) => Response | Promise<Response> = () =>
	new Response("not found", { status: 404 });
let peer: ReturnType<typeof Bun.serve>;
let missingPeer: ReturnType<typeof Bun.serve>;

beforeAll(() => {
	peer = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			peerRequests.push({
				method: request.method,
				peerLookup: request.headers.get("x-cap-peer-lookup"),
				secret: request.headers.get("x-media-server-secret"),
			});
			return respond(request);
		},
	});
	missingPeer = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () => new Response("not found", { status: 404 }),
	});
	process.env.MEDIA_SERVER_PEERS = `http://127.0.0.1:${missingPeer.port}, http://127.0.0.1:${peer.port}/`;
});

afterEach(() => {
	peerRequests.length = 0;
	respond = () => new Response("not found", { status: 404 });
});

afterAll(async () => {
	delete process.env.MEDIA_SERVER_PEERS;
	await peer.stop(true);
	await missingPeer.stop(true);
});

function statusRequest(jobId: string, headers: Record<string, string> = {}) {
	return new Request(`http://localhost/video/process/${jobId}/status`, {
		headers: { "x-media-server-secret": SECRET, ...headers },
	});
}

describe("peer job lookup", () => {
	test("parses configured peers and drops invalid entries", () => {
		expect(
			mediaServerPeers({
				MEDIA_SERVER_PEERS:
					"http://10.0.0.1:3456/, nonsense, ftp://x, https://b",
			}),
		).toEqual(["http://10.0.0.1:3456", "https://b"]);
		expect(mediaServerPeers({})).toEqual([]);
	});

	test("answers a status request with the peer that owns the job", async () => {
		respond = () =>
			Response.json({ jobId: "job-elsewhere", videoId: "v1", phase: "error" });
		const response = await app.fetch(statusRequest("job-elsewhere"));
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			jobId: "job-elsewhere",
			videoId: "v1",
			phase: "error",
		});
		expect(peerRequests).toHaveLength(1);
		expect(peerRequests[0].peerLookup).toBe("1");
		expect(peerRequests[0].secret).toBe(SECRET);
	});

	test("still answers not found when no peer has the job", async () => {
		const response = await app.fetch(statusRequest("job-nowhere"));
		expect(response.status).toBe(404);
		expect((await response.json()).code).toBe("NOT_FOUND");
	});

	test("answers a retryable 503 when a peer fails instead of answering", async () => {
		respond = () => new Response("overloaded", { status: 500 });
		const response = await app.fetch(statusRequest("job-unknown"));
		expect(response.status).toBe(503);
		expect(response.headers.get("Retry-After")).toBe("5");
		expect((await response.json()).code).toBe("PEER_LOOKUP_FAILED");
	});

	test("answers a retryable 503 when a peer cannot be reached", async () => {
		const unreachable = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => new Response(null),
		});
		const port = unreachable.port;
		await unreachable.stop(true);
		const peers = process.env.MEDIA_SERVER_PEERS;
		process.env.MEDIA_SERVER_PEERS = `${peers},http://127.0.0.1:${port}`;
		try {
			const response = await app.fetch(statusRequest("job-unreachable"));
			expect(response.status).toBe(503);
			expect(response.headers.get("Retry-After")).toBe("5");
		} finally {
			process.env.MEDIA_SERVER_PEERS = peers;
		}
	});

	test("still finds the job when another peer fails", async () => {
		respond = () => Response.json({ jobId: "job-found", phase: "processing" });
		const peers = process.env.MEDIA_SERVER_PEERS;
		const failing = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => new Response("down", { status: 502 }),
		});
		process.env.MEDIA_SERVER_PEERS = `${peers},http://127.0.0.1:${failing.port}`;
		try {
			const response = await app.fetch(statusRequest("job-found"));
			expect(response.status).toBe(200);
		} finally {
			process.env.MEDIA_SERVER_PEERS = peers;
			await failing.stop(true);
		}
	});

	test("does not forward a lookup that already came from a peer", async () => {
		respond = () => Response.json({ jobId: "job-loop", phase: "processing" });
		const response = await app.fetch(
			statusRequest("job-loop", { "x-cap-peer-lookup": "1" }),
		);
		expect(response.status).toBe(404);
		expect(peerRequests).toHaveLength(0);
	});

	test("does not forward unauthenticated status reads", async () => {
		respond = () => Response.json({ jobId: "job-public", phase: "processing" });
		const response = await app.fetch(
			new Request("http://localhost/video/process/job-public/status"),
		);
		expect(response.status).toBe(404);
		expect(peerRequests).toHaveLength(0);
	});

	test("ignores a peer that rejects the shared secret", async () => {
		respond = () => new Response("Unauthorized", { status: 401 });
		const response = await app.fetch(statusRequest("job-rejected"));
		expect(response.status).toBe(404);
	});

	test("waits for an owner that delivers its webhook before confirming a cancel", async () => {
		respond = async (request) => {
			if (request.method !== "POST")
				return new Response("not found", { status: 404 });
			await Bun.sleep(2_500);
			return Response.json({ success: true, jobId: "job-slow-cancel" });
		};
		const response = await app.fetch(
			new Request("http://localhost/video/process/job-slow-cancel/cancel", {
				method: "POST",
				headers: { "x-media-server-secret": SECRET },
			}),
		);
		expect(response.status).toBe(200);
		expect((await response.json()).success).toBe(true);
	}, 10_000);

	test("cancels a job on the peer that owns it", async () => {
		respond = (request) =>
			request.method === "POST"
				? Response.json({ success: true, jobId: "job-cancel" })
				: new Response("not found", { status: 404 });
		const response = await app.fetch(
			new Request("http://localhost/video/process/job-cancel/cancel", {
				method: "POST",
				headers: { "x-media-server-secret": SECRET },
			}),
		);
		expect(response.status).toBe(200);
		expect((await response.json()).success).toBe(true);
		expect(peerRequests.map((request) => request.method)).toEqual(["POST"]);
	});
});
