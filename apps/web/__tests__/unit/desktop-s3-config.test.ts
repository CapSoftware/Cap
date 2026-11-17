import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	isCap: "true" as string | undefined,
	nodeEnv: "production",
	user: {
		id: "usr_synthetic",
		stripeSubscriptionStatus: "active" as string | null,
		thirdPartyStripeSubscriptionId: null as string | null,
	},
	recentSaves: 0,
	inserts: [] as unknown[],
	updates: [] as unknown[],
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
vi.mock("node:dns/promises", () => ({
	lookup: async () => [{ address: "93.184.216.34", family: 4 }],
}));
vi.mock("@/app/api/utils", () => ({
	withAuth: async (
		c: { set: (key: string, value: unknown) => void },
		next: () => Promise<void>,
	) => {
		c.set("user", state.user);
		await next();
	},
}));
vi.mock("@cap/utils", () => ({
	userIsPro: (user: { stripeSubscriptionStatus?: string | null }) =>
		state.isCap !== "true" || user.stripeSubscriptionStatus === "active",
}));
vi.mock("@cap/database/crypto", () => ({
	encrypt: async (value: string) => `enc:${value}`,
	decrypt: async (value: string) => value.replace(/^enc:/, ""),
}));
vi.mock("@cap/database/helpers", async (importOriginal) => ({
	...(await importOriginal<typeof import("@cap/database/helpers")>()),
	nanoId: () => "synthetic_id",
}));
vi.mock("@cap/database", () => {
	const client = {
		select: (fields?: Record<string, unknown>) => ({
			from: () => ({
				where: () =>
					fields && "value" in fields
						? Promise.resolve([{ value: state.recentSaves }])
						: {
								limit: async () => [{ preferences: null }],
								for: async () => [{ id: "usr_synthetic" }],
							},
			}),
		}),
		update: () => ({
			set: (values: unknown) => ({
				where: async () => {
					state.updates.push(values);
				},
			}),
		}),
		insert: () => ({
			values: async (values: unknown) => {
				state.inserts.push(values);
			},
		}),
		transaction: async (callback: (tx: unknown) => Promise<unknown>) =>
			callback(client),
	};
	return { db: () => client };
});

import { app } from "@/app/api/desktop/[...route]/s3Config";

const save = (endpoint: string) =>
	app.request("/", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"x-real-ip": "198.51.100.7",
		},
		body: JSON.stringify({
			provider: "aws",
			accessKeyId: "AKIASYNTHETIC",
			secretAccessKey: "synthetic-secret",
			endpoint,
			bucketName: "synthetic-bucket",
			region: "us-east-1",
		}),
	});

const testConnection = (endpoint: string) =>
	app.request("/test", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"x-real-ip": "198.51.100.7",
		},
		body: JSON.stringify({
			provider: "aws",
			accessKeyId: "AKIASYNTHETIC",
			secretAccessKey: "synthetic-secret",
			endpoint,
			bucketName: "synthetic-bucket",
			region: "us-east-1",
		}),
	});

describe("desktop personal S3 config", () => {
	let warn: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		state.isCap = "true";
		state.nodeEnv = "production";
		state.user.stripeSubscriptionStatus = "active";
		state.recentSaves = 0;
		state.inserts = [];
		state.updates = [];
		warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
	});

	it("saves https storage for Pro users", async () => {
		const response = await save("https://s3.example.com");
		expect(response.status).toBe(200);
		expect(state.inserts).toHaveLength(1);
		expect(warn).toHaveBeenCalledWith(
			"[custom-storage] config attempt",
			expect.objectContaining({
				userId: "usr_synthetic",
				action: "save_personal",
				outcome: "allowed",
				reason: null,
				endpointHost: "s3.example.com",
				clientIp: "198.51.100.7",
			}),
		);
		expect(JSON.stringify(warn.mock.calls)).not.toContain("AKIASYNTHETIC");
		expect(JSON.stringify(warn.mock.calls)).not.toContain("synthetic-secret");
	});

	it("requires Pro on Cap Cloud with the desktop error shape", async () => {
		state.user.stripeSubscriptionStatus = null;
		const response = await save("https://s3.example.com");
		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({
			error: "Cap Pro is required to use custom storage",
			details: "Cap Pro is required to use custom storage",
		});
		expect(state.inserts).toHaveLength(0);
		expect(warn).toHaveBeenCalledWith(
			"[custom-storage] config attempt",
			expect.objectContaining({ outcome: "rejected", reason: "pro_required" }),
		);
	});

	it("requires https on Cap Cloud", async () => {
		const response = await save("http://s3.example.com");
		expect(response.status).toBe(400);
		expect(state.inserts).toHaveLength(0);
	});

	it("rejects IP literal endpoints on Cap Cloud", async () => {
		const response = await save("https://93.184.216.34");
		expect(response.status).toBe(400);
		expect(state.inserts).toHaveLength(0);
	});

	it("returns 429 when a parallel save fills the hourly limit first", async () => {
		const response = await (async () => {
			let checks = 0;
			const original = state.recentSaves;
			Object.defineProperty(state, "recentSaves", {
				configurable: true,
				get: () => (checks++ === 0 ? original : 5),
			});
			try {
				return await save("https://s3.example.com");
			} finally {
				Object.defineProperty(state, "recentSaves", {
					configurable: true,
					writable: true,
					value: original,
				});
			}
		})();
		expect(response.status).toBe(429);
		expect(state.inserts).toHaveLength(0);
	});

	it("returns 429 after five saves in an hour", async () => {
		state.recentSaves = 5;
		const response = await save("https://s3.example.com");
		expect(response.status).toBe(429);
		expect(state.inserts).toHaveLength(0);
	});

	it("requires Pro to test a connection on Cap Cloud", async () => {
		state.user.stripeSubscriptionStatus = null;
		const response = await testConnection("https://s3.example.com");
		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({
			error: "Cap Pro is required to use custom storage",
			details: "Cap Pro is required to use custom storage",
		});
		expect(warn).toHaveBeenCalledWith(
			"[custom-storage] config attempt",
			expect.objectContaining({
				action: "test_personal",
				outcome: "rejected",
				reason: "pro_required",
			}),
		);
	});

	it("keeps self-hosted saves unchanged", async () => {
		state.isCap = undefined;
		state.user.stripeSubscriptionStatus = null;
		const response = await save("http://localhost:9000");
		expect(response.status).toBe(200);
		expect(state.inserts).toHaveLength(1);
	});

	it("lets non-Pro users remove an existing config", async () => {
		state.user.stripeSubscriptionStatus = null;
		const response = await app.request("/delete", { method: "DELETE" });
		expect(response.status).toBe(200);
		expect(state.updates).toEqual([{ active: false }]);
	});
});
