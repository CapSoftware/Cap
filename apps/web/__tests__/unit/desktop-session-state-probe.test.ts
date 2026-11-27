import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	inserted: 0,
	user: null as null | { id: string },
}));

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
	getCurrentUser: async () => state.user,
}));
vi.mock("@cap/database/auth/auth-options", () => ({
	decodeSessionToken: vi.fn(),
}));
vi.mock("@cap/env", () => ({
	serverEnv: () => ({
		NEXTAUTH_SECRET: "secret",
		WEB_URL: "https://cap.example",
	}),
}));

const WELL_FORMED = "abcdefghijklmnopqrstuvwxyz012345";

const request = async (query: string) => {
	const { app } = await import("@/app/api/desktop/[...route]/session");
	return app.request(`https://cap.example/request?${query}`);
};

beforeEach(() => {
	state.inserted = 0;
	state.user = null;
});

describe("desktop sign-in state support, as the desktop app checks it", () => {
	it("rejects a malformed state with 400 before signing anyone in", async () => {
		const res = await request("type=api_key&state=x");
		expect(res.status).toBe(400);
		expect(state.inserted).toBe(0);
	});

	it("does not reject a well-formed state", async () => {
		const res = await request(`type=api_key&state=${WELL_FORMED}`);
		expect(res.status).toBe(302);
		expect(res.headers.get("location")).toContain("/login");
	});

	it("returns the state on the loopback callback for a signed-in user", async () => {
		state.user = { id: "user-1" };
		const res = await request(
			`type=api_key&platform=web&port=49152&state=${WELL_FORMED}`,
		);
		const location = new URL(res.headers.get("location") ?? "");
		expect(location.hostname).toBe("127.0.0.1");
		expect(location.searchParams.get("state")).toBe(WELL_FORMED);
		expect(location.searchParams.get("user_id")).toBe("user-1");
	});
});
