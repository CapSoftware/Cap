import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	it,
	vi,
} from "vitest";

// Whatever NODE_ENV says, the code a route or the delivery workflow runs
// (no guards passed) never reaches plain http or a private address.
const env = vi.hoisted(() => ({
	NODE_ENV: "development" as string | undefined,
	buildEnv: { NEXT_PUBLIC_IS_CAP: "false" },
	serverEnv: () => ({}),
}));
vi.mock("@cap/env", () => env);
vi.mock("@cap/database", () => ({ db: () => ({}) }));

const { checkWebhookUrl, sendDeveloperWebhook, webhookUrlProblem } =
	await import("@/lib/developer-webhook-delivery");

const event = {
	secret: "cws_0123456789abcdefghjkmnpqrstvwx",
	eventId: "evt_1",
	eventType: "video.ready",
	body: "{}",
};

let server: Server;
let port: number;
let hits = 0;

beforeAll(async () => {
	server = createServer((_req, res) => {
		hits += 1;
		res.end("ok");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
	await new Promise((resolve) => server.close(resolve));
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe.each([
	"development",
	"test",
	"staging",
	"preview",
	"",
	undefined,
	"production",
])("with NODE_ENV %s", (nodeEnv) => {
	it("refuses private and plain http targets on create and on delivery", async () => {
		env.NODE_ENV = nodeEnv;
		vi.stubEnv("NODE_ENV", nodeEnv);
		hits = 0;

		expect(webhookUrlProblem(`http://127.0.0.1:${port}/`)).toBe(
			"https_required",
		);
		expect(await checkWebhookUrl("https://127.0.0.1/cap")).toBe(
			"private_address",
		);
		expect(await checkWebhookUrl("https://localhost/cap")).toBe(
			"private_address",
		);
		expect(await checkWebhookUrl("https://169.254.169.254/cap")).toBe(
			"private_address",
		);

		for (const url of [
			`http://127.0.0.1:${port}/`,
			`http://localhost:${port}/`,
			"https://127.0.0.1/cap",
			"https://[::1]/cap",
		]) {
			const result = await sendDeveloperWebhook({ ...event, url });
			expect(result.ok).toBe(false);
		}
		expect(hits).toBe(0);
	});
});

it("reaches a local server only when a test passes allowPrivate", async () => {
	hits = 0;
	const result = await sendDeveloperWebhook(
		{ ...event, url: `http://127.0.0.1:${port}/` },
		{ allowPrivate: true },
	);
	expect(result.ok).toBe(true);
	expect(hits).toBe(1);
});
