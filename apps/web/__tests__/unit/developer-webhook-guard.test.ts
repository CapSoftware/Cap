import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@cap/env", () => ({
	NODE_ENV: "production",
	buildEnv: { NEXT_PUBLIC_IS_CAP: "true" },
	serverEnv: () => ({}),
}));
vi.mock("@cap/database", () => ({ db: () => ({}) }));

const {
	allowsPrivateWebhookTargets,
	checkWebhookUrl,
	sendDeveloperWebhook,
	webhookUrlProblem,
} = await import("@/lib/developer-webhook-delivery");
const { isBlockedS3Endpoint, isPrivateAddress } = await import(
	"@/lib/s3-endpoint-policy"
);
const { requestPublicOnly } = await import("@/lib/storage-fetch");
const { verifyWebhookSignature } = await import(
	"@/lib/developer-webhook-signature"
);

const resolvesTo =
	(...addresses: string[]) =>
	(url: string) =>
		isBlockedS3Endpoint(url, async () => addresses);

const event = {
	secret: "cws_0123456789abcdefghjkmnpqrstvwx",
	eventId: "evt_1",
	eventType: "video.ready",
	body: JSON.stringify({ id: "evt_1", type: "video.ready" }),
};

describe("webhook URL policy in a production build", () => {
	it("is strict in production", () => {
		expect(allowsPrivateWebhookTargets()).toBe(false);
	});

	it("accepts a public https URL", () => {
		expect(webhookUrlProblem("https://hooks.example.com/cap?x=1")).toBeNull();
	});

	it.each([
		["plain http", "http://hooks.example.com/cap", "https_required"],
		["another scheme", "ftp://hooks.example.com/cap", "https_required"],
		["a file URL", "file:///etc/passwd", "https_required"],
		["no scheme", "hooks.example.com/cap", "invalid_url"],
		["an empty value", "", "invalid_url"],
		[
			"a URL over the length cap",
			`https://hooks.example.com/${"a".repeat(2_048)}`,
			"invalid_url",
		],
		[
			"a username and password",
			"https://user:pass@hooks.example.com/cap",
			"credentials_in_url",
		],
		["another port", "https://hooks.example.com:8443/cap", "unsupported_port"],
		["localhost", "https://localhost/cap", "private_address"],
		["a localhost subdomain", "https://app.localhost/cap", "private_address"],
		["an internal name", "https://db.internal/cap", "private_address"],
		["a .local name", "https://printer.local/cap", "private_address"],
		["loopback v4", "https://127.0.0.1/cap", "private_address"],
		["private 10/8", "https://10.1.2.3/cap", "private_address"],
		["private 172.16/12", "https://172.20.0.1/cap", "private_address"],
		["private 192.168/16", "https://192.168.1.10/cap", "private_address"],
		["carrier NAT", "https://100.64.0.1/cap", "private_address"],
		["the metadata address", "https://169.254.169.254/cap", "private_address"],
		["the unspecified address", "https://0.0.0.0/cap", "private_address"],
		["a documentation range", "https://203.0.113.9/cap", "private_address"],
		["multicast", "https://224.0.0.1/cap", "private_address"],
		["a decimal loopback", "https://2130706433/cap", "private_address"],
		["a hex loopback", "https://0x7f.1/cap", "private_address"],
		["an octal loopback", "https://017700000001/cap", "private_address"],
		["loopback v6", "https://[::1]/cap", "private_address"],
		["unique local v6", "https://[fd00:ec2::254]/cap", "private_address"],
		["link-local v6", "https://[fe80::1]/cap", "private_address"],
		["mapped v4 loopback", "https://[::ffff:127.0.0.1]/cap", "private_address"],
		["mapped v4 private", "https://[::ffff:a00:1]/cap", "private_address"],
		[
			"mapped v4 metadata",
			"https://[::ffff:169.254.169.254]/cap",
			"private_address",
		],
		[
			"NAT64 of a private v4",
			"https://[64:ff9b::a00:1]/cap",
			"private_address",
		],
		["6to4 of loopback", "https://[2002:7f00:1::]/cap", "private_address"],
		["Teredo", "https://[2001:0:4136:e378::1]/cap", "private_address"],
	])("refuses %s", (_label, url, problem) => {
		expect(webhookUrlProblem(url)).toBe(problem);
	});

	it("refuses a name that resolves to a private address", async () => {
		for (const address of ["10.0.0.5", "127.0.0.1", "::1", "::ffff:10.0.0.5"]) {
			expect(
				await checkWebhookUrl("https://hooks.example.com/cap", {
					isBlocked: resolvesTo(address),
				}),
			).toBe("private_address");
		}
	});

	it("refuses a name with one private address among public ones", async () => {
		expect(
			await checkWebhookUrl("https://hooks.example.com/cap", {
				isBlocked: resolvesTo("93.184.216.34", "192.168.0.7"),
			}),
		).toBe("private_address");
	});

	it("refuses a name that does not resolve", async () => {
		expect(
			await checkWebhookUrl("https://hooks.example.com/cap", {
				isBlocked: resolvesTo(),
			}),
		).toBe("private_address");
	});

	it("accepts a name that resolves to public addresses only", async () => {
		expect(
			await checkWebhookUrl("https://hooks.example.com/cap", {
				isBlocked: resolvesTo("93.184.216.34", "2606:2800:220:1::1"),
			}),
		).toBeNull();
	});

	it("covers the reserved ranges added for webhooks", () => {
		for (const address of [
			"192.0.2.1",
			"198.51.100.1",
			"203.0.113.1",
			"192.88.99.1",
			"2001:db8::1",
			"100::1",
			"64:ff9b:1::1",
			"2002:a00:1::1",
			"2001:0:1::1",
		]) {
			expect(isPrivateAddress(address)).toBe(true);
		}
		for (const address of ["93.184.216.34", "8.8.8.8", "2606:4700::1111"]) {
			expect(isPrivateAddress(address)).toBe(false);
		}
	});
});

describe("sending a webhook in a production build", () => {
	let server: Server;
	let port: number;
	let hits = 0;

	beforeAll(async () => {
		server = createServer((_req, res) => {
			hits += 1;
			res.end("internal");
		});
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
		port = (server.address() as AddressInfo).port;
	});

	afterAll(async () => {
		await new Promise((resolve) => server.close(resolve));
	});

	it("does not connect to a private address written as a literal", async () => {
		await expect(
			requestPublicOnly(`http://127.0.0.1:${port}/`, { method: "POST" }),
		).rejects.toThrow("Refused to connect to private address");
		await expect(
			requestPublicOnly(`http://[::ffff:127.0.0.1]:${port}/`),
		).rejects.toThrow("Refused to connect to private address");
		expect(hits).toBe(0);
	});

	it("does not connect when the name resolves to a private address at connect time", async () => {
		const request = vi.fn((url: string, init: RequestInit) =>
			requestPublicOnly(url.replace("hooks.example.com", "localhost"), init),
		);
		const result = await sendDeveloperWebhook(
			{ ...event, url: `https://hooks.example.com/cap` },
			{ isBlocked: async () => false, request },
		);
		expect(request).toHaveBeenCalledTimes(1);
		expect(result).toMatchObject({ ok: false, errorCode: "private_address" });
		expect(hits).toBe(0);
	});

	it("sends nothing when the URL no longer passes the policy", async () => {
		const request = vi.fn();
		for (const url of [
			"http://hooks.example.com/cap",
			"https://127.0.0.1/cap",
			"https://user:pass@hooks.example.com/cap",
		]) {
			const result = await sendDeveloperWebhook({ ...event, url }, { request });
			expect(result.ok).toBe(false);
		}
		const rebound = await sendDeveloperWebhook(
			{ ...event, url: "https://hooks.example.com/cap" },
			{ request, isBlocked: resolvesTo("10.0.0.5") },
		);
		expect(rebound).toMatchObject({ ok: false, errorCode: "private_address" });
		expect(request).not.toHaveBeenCalled();
	});

	it("treats a redirect as a failed delivery and never follows it", async () => {
		const request = vi.fn(
			async () =>
				new Response("moved", {
					status: 302,
					headers: { location: "http://169.254.169.254/latest/meta-data/" },
				}),
		);
		const result = await sendDeveloperWebhook(
			{ ...event, url: "https://hooks.example.com/cap" },
			{ isBlocked: async () => false, request },
		);
		expect(result).toMatchObject({
			ok: false,
			errorCode: "redirect",
			responseStatus: 302,
		});
		expect(request).toHaveBeenCalledTimes(1);
	});

	it("signs the request and names the event in headers", async () => {
		const seen: { url: string; init: RequestInit }[] = [];
		const result = await sendDeveloperWebhook(
			{ ...event, url: "https://hooks.example.com/cap" },
			{
				isBlocked: async () => false,
				request: async (url, init) => {
					seen.push({ url, init });
					return new Response(null, { status: 204 });
				},
			},
		);
		expect(result).toMatchObject({ ok: true, responseStatus: 204 });
		const [sent] = seen;
		const headers = new Headers(sent?.init.headers);
		expect(sent?.init.method).toBe("POST");
		expect(sent?.init.body).toBe(event.body);
		expect(headers.get("content-type")).toBe("application/json");
		expect(headers.get("cap-event-id")).toBe("evt_1");
		expect(headers.get("cap-event-type")).toBe("video.ready");
		expect(
			verifyWebhookSignature({
				secret: event.secret,
				body: event.body,
				header: headers.get("cap-signature"),
			}),
		).toBe(true);
	});

	it.each([
		[200, true],
		[201, true],
		[299, true],
		[400, false],
		[404, false],
		[500, false],
	])("counts %i as delivered: %s", async (status, delivered) => {
		const result = await sendDeveloperWebhook(
			{ ...event, url: "https://hooks.example.com/cap" },
			{
				isBlocked: async () => false,
				request: async () => new Response("x", { status }),
			},
		);
		expect(result.ok).toBe(delivered);
		expect(result.responseStatus).toBe(status);
	});
});
