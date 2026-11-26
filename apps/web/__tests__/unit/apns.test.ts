import { generateKeyPairSync, verify } from "node:crypto";
import { EventEmitter } from "node:events";
import type { connect } from "node:http2";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@cap/env", () => ({ serverEnv: () => ({}) }));

import {
	APNS_TOPIC,
	type ApnsConfig,
	apnsPayload,
	providerToken,
	resetProviderTokenCache,
	sendPushes,
} from "@/lib/apns";

const { privateKey, publicKey } = generateKeyPairSync("ec", {
	namedCurve: "P-256",
});
const config: ApnsConfig = {
	keyId: "KEY1234567",
	teamId: "TEAM123456",
	privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
};

const message = {
	title: "Launch demo",
	body: "Alex commented: Nice",
	capId: "cap123",
};

type Reply = { status: number; body?: string } | "hang" | "error";

const fakeConnect = (replies: Record<string, Reply>) => {
	const requests: {
		host: string;
		headers: Record<string, string>;
		body: string;
	}[] = [];
	const connectTo = ((host: string) => {
		const session = new EventEmitter() as EventEmitter & {
			request: (headers: Record<string, string>) => unknown;
			close: () => void;
		};
		session.close = () => {};
		session.request = (headers) => {
			const request = new EventEmitter() as EventEmitter &
				Record<string, unknown>;
			const token = headers[":path"]?.split("/").pop() ?? "";
			request.setTimeout = (_ms: number, onTimeout: () => void) => {
				if (replies[token] === "hang") setTimeout(onTimeout, 0);
			};
			request.close = () => {};
			request.setEncoding = () => {};
			request.end = (body: string) => {
				requests.push({ host, headers, body });
				const reply = replies[token];
				setTimeout(() => {
					if (reply === "hang") return;
					if (reply === "error")
						return request.emit("error", new Error("reset"));
					request.emit("response", { ":status": reply?.status ?? 200 });
					if (reply?.body) request.emit("data", reply.body);
					request.emit("end");
				}, 0);
			};
			return request;
		};
		return session;
	}) as unknown as typeof connect;
	return { connectTo, requests };
};

describe("APNs provider token", () => {
	beforeEach(() => resetProviderTokenCache());

	it("signs an ES256 JWT Apple can verify", () => {
		const token = providerToken(config, 1_700_000_000_000);
		const [header, claims, signature] = token.split(".");
		expect(
			JSON.parse(Buffer.from(header ?? "", "base64url").toString()),
		).toEqual({
			alg: "ES256",
			kid: "KEY1234567",
		});
		expect(
			JSON.parse(Buffer.from(claims ?? "", "base64url").toString()),
		).toEqual({
			iss: "TEAM123456",
			iat: 1_700_000_000,
		});
		expect(
			verify(
				"SHA256",
				Buffer.from(`${header}.${claims}`),
				{ key: publicKey, dsaEncoding: "ieee-p1363" },
				Buffer.from(signature ?? "", "base64url"),
			),
		).toBe(true);
	});

	it("reuses the token for 50 minutes, then signs a new one", () => {
		const start = 1_700_000_000_000;
		const first = providerToken(config, start);
		expect(providerToken(config, start + 49 * 60 * 1000)).toBe(first);
		expect(providerToken(config, start + 51 * 60 * 1000)).not.toBe(first);
	});
});

describe("sendPushes", () => {
	beforeEach(() => resetProviderTokenCache());

	it("sends an alert to the right host with the Cap's id", async () => {
		const { connectTo, requests } = fakeConnect({});
		const results = await sendPushes(
			config,
			[
				{ token: "aa11", environment: "production" },
				{ token: "bb22", environment: "sandbox" },
			],
			message,
			connectTo,
		);
		expect([...results]).toEqual([
			["aa11", "sent"],
			["bb22", "sent"],
		]);
		const production = requests.find(
			(r) => r.headers[":path"] === "/3/device/aa11",
		);
		const sandbox = requests.find(
			(r) => r.headers[":path"] === "/3/device/bb22",
		);
		expect(production?.host).toBe("https://api.push.apple.com");
		expect(sandbox?.host).toBe("https://api.sandbox.push.apple.com");
		expect(production?.headers["apns-topic"]).toBe(APNS_TOPIC);
		expect(production?.headers["apns-push-type"]).toBe("alert");
		expect(production?.headers.authorization).toMatch(
			/^bearer [\w-]+\.[\w-]+\.[\w-]+$/,
		);
		expect(JSON.parse(production?.body ?? "{}")).toEqual(
			JSON.parse(apnsPayload(message)),
		);
		expect(JSON.parse(production?.body ?? "{}").capId).toBe("cap123");
	});

	it("marks dead tokens invalid and keeps other failures as failed", async () => {
		const { connectTo } = fakeConnect({
			gone: { status: 410, body: '{"reason":"Unregistered"}' },
			bad: { status: 400, body: '{"reason":"BadDeviceToken"}' },
			payload: { status: 400, body: '{"reason":"PayloadTooLarge"}' },
			busy: { status: 503, body: '{"reason":"ServiceUnavailable"}' },
			reset: "error",
			slow: "hang",
		});
		vi.spyOn(console, "error").mockImplementation(() => {});
		const results = await sendPushes(
			config,
			["gone", "bad", "payload", "busy", "reset", "slow"].map((token) => ({
				token,
				environment: "production" as const,
			})),
			message,
			connectTo,
		);
		expect(Object.fromEntries(results)).toEqual({
			gone: "invalid-token",
			bad: "invalid-token",
			payload: "failed",
			busy: "failed",
			reset: "failed",
			slow: "failed",
		});
	});

	it("fails every target without throwing when the key can't sign", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const results = await sendPushes(
			{ ...config, privateKey: "not a key" },
			[{ token: "aa11", environment: "production" }],
			message,
			fakeConnect({}).connectTo,
		);
		expect(results.get("aa11")).toBe("failed");
	});
});
