import type { User } from "@cap/web-domain";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	isCap: "true" as string | undefined,
	nodeEnv: "production",
	isPro: true,
	recentSaves: 0,
	preferences: null as unknown,
}));

vi.mock("@cap/env", () => ({
	buildEnv: {
		get NEXT_PUBLIC_IS_CAP() {
			return state.isCap;
		},
	},
	get NODE_ENV() {
		return state.nodeEnv;
	},
}));
vi.mock("@cap/utils", () => ({ userIsPro: () => state.isPro }));
vi.mock("@cap/database", () => ({
	db: () => ({
		select: (fields: Record<string, unknown>) => ({
			from: () => ({
				where: () =>
					"value" in fields
						? Promise.resolve([{ value: state.recentSaves }])
						: { limit: async () => [{ preferences: state.preferences }] },
			}),
		}),
	}),
}));

import { getClientIp } from "@/lib/client-ip";
import {
	CUSTOM_STORAGE_SAVE_LIMIT,
	getCustomStorageSaveRejection,
	getEndpointHostForLog,
	isInsecureS3Endpoint,
	logCustomStorageAttempt,
} from "@/lib/custom-storage-policy";
import { isRestrictedCustomStorageHost } from "@/lib/s3-endpoint-policy";

const user = { id: "usr_synthetic" as User.UserId };

describe("custom storage save policy", () => {
	beforeEach(() => {
		state.isCap = "true";
		state.nodeEnv = "production";
		state.isPro = true;
		state.recentSaves = 0;
		state.preferences = null;
	});

	it("allows https saves for Pro users on Cap Cloud", async () => {
		await expect(
			getCustomStorageSaveRejection({
				user,
				endpoint: "https://s3.example.com",
			}),
		).resolves.toBeNull();
		await expect(
			getCustomStorageSaveRejection({ user, endpoint: "" }),
		).resolves.toBeNull();
	});

	it("requires Pro", async () => {
		state.isPro = false;
		await expect(
			getCustomStorageSaveRejection({
				user,
				endpoint: "https://s3.example.com",
			}),
		).resolves.toMatchObject({ reason: "pro_required", status: 403 });
	});

	it("requires https on Cap Cloud", async () => {
		await expect(
			getCustomStorageSaveRejection({
				user,
				endpoint: "http://s3.example.com",
			}),
		).resolves.toMatchObject({ reason: "https_required", status: 400 });
	});

	it("rejects IP literal and tunnel hosts on Cap Cloud", async () => {
		for (const endpoint of [
			"https://203.0.113.10",
			"https://[2001:db8::1]:9000",
			"https://abc.trycloudflare.com",
			"https://webhook.site",
			"https://x.oast.fun",
		]) {
			await expect(
				getCustomStorageSaveRejection({ user, endpoint }),
			).resolves.toMatchObject({ reason: "endpoint_not_allowed", status: 400 });
		}
	});

	it("rejects saves while media processing is suspended", async () => {
		state.preferences = {
			mediaInputPolicy: { strikes: [], suspendedAt: "2026-11-01T00:00:00Z" },
		};
		await expect(
			getCustomStorageSaveRejection({
				user,
				endpoint: "https://s3.example.com",
			}),
		).resolves.toMatchObject({ reason: "unavailable", status: 403 });
	});

	it("rate limits after the hourly save limit", async () => {
		state.recentSaves = CUSTOM_STORAGE_SAVE_LIMIT - 1;
		await expect(
			getCustomStorageSaveRejection({
				user,
				endpoint: "https://s3.example.com",
			}),
		).resolves.toBeNull();
		state.recentSaves = CUSTOM_STORAGE_SAVE_LIMIT;
		await expect(
			getCustomStorageSaveRejection({
				user,
				endpoint: "https://s3.example.com",
			}),
		).resolves.toMatchObject({ reason: "rate_limited", status: 429 });
	});

	it.each([
		["self-hosted", undefined, "production"],
		["development", "true", "development"],
	])("keeps %s deployments unchanged", async (_, isCap, nodeEnv) => {
		state.isCap = isCap;
		state.nodeEnv = nodeEnv;
		for (const endpoint of [
			"http://localhost:9000",
			"http://192.168.1.10:9000",
			"https://abc.ngrok.io",
		]) {
			await expect(
				getCustomStorageSaveRejection({ user, endpoint }),
			).resolves.toBeNull();
		}
	});
});

describe("custom storage endpoint helpers", () => {
	it("flags non-https endpoints only when required", () => {
		expect(isInsecureS3Endpoint("http://s3.example.com", true)).toBe(true);
		expect(isInsecureS3Endpoint("ftp://s3.example.com", true)).toBe(true);
		expect(isInsecureS3Endpoint("not a url", true)).toBe(true);
		expect(isInsecureS3Endpoint(" https://s3.example.com ", true)).toBe(false);
		expect(isInsecureS3Endpoint("", true)).toBe(false);
		expect(isInsecureS3Endpoint("http://s3.example.com", false)).toBe(false);
	});

	it("matches restricted hosts exactly or by subdomain", () => {
		expect(isRestrictedCustomStorageHost("https://ngrok.io")).toBe(true);
		expect(isRestrictedCustomStorageHost("https://a.b.ngrok.io")).toBe(true);
		expect(isRestrictedCustomStorageHost("https://bucket.a.pinggy.io")).toBe(
			true,
		);
		expect(isRestrictedCustomStorageHost("https://share.zrok.io.")).toBe(true);
		expect(isRestrictedCustomStorageHost("https://notngrok.io")).toBe(false);
		expect(isRestrictedCustomStorageHost("https://pinggy.io")).toBe(false);
		expect(isRestrictedCustomStorageHost("https://s3.amazonaws.com")).toBe(
			false,
		);
		expect(isRestrictedCustomStorageHost("https://1.2.3.4:9000")).toBe(true);
	});

	it("logs only the endpoint host", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		logCustomStorageAttempt({
			userId: user.id,
			action: "save_personal",
			rejection: "https_required",
			endpoint: "http://user:pass@s3.example.com/path?X-Amz-Signature=secret",
			clientIp: "198.51.100.7",
		});
		expect(warn).toHaveBeenCalledWith("[custom-storage] config attempt", {
			userId: user.id,
			action: "save_personal",
			organizationId: null,
			outcome: "rejected",
			reason: "https_required",
			endpointHost: "s3.example.com",
			clientIp: "198.51.100.7",
		});
		expect(JSON.stringify(warn.mock.calls)).not.toContain("secret");
		expect(JSON.stringify(warn.mock.calls)).not.toContain("pass");
		expect(getEndpointHostForLog("")).toBe("default");
		expect(getEndpointHostForLog("::")).toBe("invalid");
		warn.mockRestore();
	});

	it("reads the client IP from proxy headers", () => {
		const headers = (values: Record<string, string>) => (name: string) =>
			values[name];
		expect(
			getClientIp(
				headers({ "x-real-ip": "198.51.100.7", "x-forwarded-for": "1.1.1.1" }),
			),
		).toBe("198.51.100.7");
		expect(
			getClientIp(headers({ "x-forwarded-for": " 203.0.113.5 , 10.0.0.1" })),
		).toBe("203.0.113.5");
		expect(getClientIp(headers({}))).toBeNull();
	});
});
