import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetTorExitListCache } from "@/lib/tor-exit-gate";

const state = vi.hoisted(() => ({ inserted: 0 }));

vi.mock("@cap/database", () => {
	const tx = {
		select: () => ({
			from: () => ({
				where: () =>
					Object.assign(Promise.resolve([{ total: 0 }]), {
						for: async () => [],
						orderBy: () => ({ limit: () => ({ offset: async () => [] }) }),
					}),
			}),
		}),
		insert: () => ({
			values: async () => {
				state.inserted += 1;
			},
		}),
		delete: () => ({ where: async () => {} }),
	};
	return {
		db: () => ({
			...tx,
			transaction: async (callback: (value: typeof tx) => Promise<unknown>) =>
				callback(tx),
		}),
	};
});
vi.mock("@/lib/rate-limit", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/rate-limit")>()),
	isRateLimited: async () => false,
}));
vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: async () => ({ id: "user-1" }),
}));
vi.mock("@cap/database/auth/auth-options", () => ({
	decodeSessionToken: vi.fn(),
}));
vi.mock("@cap/env", () => ({
	serverEnv: () => ({
		NEXTAUTH_SECRET: "secret",
		WEB_URL: "https://cap.example",
		CAP_TOR_EXIT_GATE: "deny",
	}),
}));

const LISTED = "198.51.100.7";
const UNLISTED = "203.0.113.20";
const list = [
	...Array.from({ length: 60 }, (_, i) => `192.0.2.${i + 1}`),
	LISTED,
].join("\n");

const requestApiKey = async (address: string) => {
	const { app } = await import("@/app/api/desktop/[...route]/session");
	return app.request(
		"https://cap.example/request?type=api_key&platform=web&port=49152",
		{ headers: { "x-real-ip": address } },
	);
};

beforeEach(() => {
	state.inserted = 0;
	resetTorExitListCache();
	vi.stubEnv("VERCEL", "1");
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(list)),
	);
	vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

describe("desktop session request", () => {
	it("refuses a Tor exit with the blocked notice and creates no key", async () => {
		const response = await requestApiKey(LISTED);

		expect(response.status).toBe(302);
		const location = new URL(response.headers.get("location") ?? "");
		expect(location.pathname).toBe("/login");
		expect(location.searchParams.get("error")).toBe("SignupBlocked");
		expect(state.inserted).toBe(0);
	});

	it("issues a key to other addresses", async () => {
		const response = await requestApiKey(UNLISTED);

		const location = new URL(response.headers.get("location") ?? "");
		expect(location.hostname).toBe("127.0.0.1");
		expect(location.searchParams.get("api_key")).toMatch(/^[0-9a-f-]{36}$/);
		expect(state.inserted).toBe(1);
	});
});
