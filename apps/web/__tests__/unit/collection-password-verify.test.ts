import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	headers: vi.fn(),
	checkRateLimit: vi.fn(),
	revalidatePath: vi.fn(),
	setVerifiedPasswordCookie: vi.fn(),
	verifyPassword: vi.fn(),
	getPublicCollectionPasswordHash: vi.fn(),
}));

vi.mock("next/headers", () => ({ headers: mocks.headers }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@vercel/firewall", () => ({ checkRateLimit: mocks.checkRateLimit }));
vi.mock("@cap/database/crypto", () => ({
	verifyPassword: mocks.verifyPassword,
}));
vi.mock("@/lib/password-cookie", () => ({
	setVerifiedPasswordCookie: mocks.setVerifiedPasswordCookie,
}));
vi.mock("@/lib/public-collections", () => ({
	getPublicCollectionPasswordHash: mocks.getPublicCollectionPasswordHash,
}));

const TOO_MANY = {
	success: false,
	error: "Too many attempts. Please try again later.",
};
const WRONG = { success: false, error: "Failed to verify password" };
const VERIFIED = { success: true, value: "Password verified" };

const loadAction = async () => {
	vi.resetModules();
	return (await import("@/actions/collections/password"))
		.verifyCollectionPassword;
};

const fromIp = (ip: string) =>
	mocks.headers.mockResolvedValue(new Headers({ "x-real-ip": ip }));

beforeEach(() => {
	mocks.headers.mockReset();
	mocks.checkRateLimit.mockReset();
	mocks.revalidatePath.mockReset();
	mocks.setVerifiedPasswordCookie.mockReset();
	mocks.verifyPassword
		.mockReset()
		.mockImplementation(
			async (hash: string, password: string) => hash === `hash:${password}`,
		);
	mocks.getPublicCollectionPasswordHash
		.mockReset()
		.mockImplementation(async (id: string) =>
			id === "collection-open" ? null : `hash:${id}-secret`,
		);
	vi.spyOn(console, "warn").mockImplementation(() => {});
	fromIp("203.0.113.1");
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("verifyCollectionPassword attempt limits", () => {
	it("verifies a correct password and sets the cookie", async () => {
		const verifyCollectionPassword = await loadAction();

		expect(
			await verifyCollectionPassword("collection-1", "collection-1-secret"),
		).toEqual(VERIFIED);
		expect(mocks.setVerifiedPasswordCookie).toHaveBeenCalledWith(
			"hash:collection-1-secret",
		);
		expect(mocks.revalidatePath).toHaveBeenCalledWith("/c/collection-1");
	});

	it("stops verifying after repeated attempts from one client", async () => {
		const verifyCollectionPassword = await loadAction();

		for (let attempt = 0; attempt < 20; attempt++) {
			expect(await verifyCollectionPassword("collection-1", "nope")).toEqual(
				WRONG,
			);
		}
		mocks.verifyPassword.mockClear();
		mocks.getPublicCollectionPasswordHash.mockClear();

		expect(
			await verifyCollectionPassword("collection-1", "collection-1-secret"),
		).toEqual(TOO_MANY);
		expect(mocks.getPublicCollectionPasswordHash).not.toHaveBeenCalled();
		expect(mocks.verifyPassword).not.toHaveBeenCalled();
		expect(mocks.setVerifiedPasswordCookie).not.toHaveBeenCalled();
	});

	it("stops verifying one collection after many attempts across clients", async () => {
		const verifyCollectionPassword = await loadAction();

		for (let client = 0; client < 10; client++) {
			fromIp(`198.51.100.${client}`);
			for (let attempt = 0; attempt < 20; attempt++) {
				await verifyCollectionPassword("collection-1", "nope");
			}
		}
		mocks.verifyPassword.mockClear();

		fromIp("192.0.2.200");
		expect(
			await verifyCollectionPassword("collection-1", "collection-1-secret"),
		).toEqual(TOO_MANY);
		expect(mocks.verifyPassword).not.toHaveBeenCalled();
		expect(mocks.setVerifiedPasswordCookie).not.toHaveBeenCalled();

		expect(
			await verifyCollectionPassword("collection-2", "collection-2-secret"),
		).toEqual(VERIFIED);
	});

	it("does not count attempts rejected per client against the collection", async () => {
		const verifyCollectionPassword = await loadAction();

		for (let attempt = 0; attempt < 500; attempt++) {
			await verifyCollectionPassword("collection-1", "nope");
		}

		fromIp("192.0.2.200");
		expect(
			await verifyCollectionPassword("collection-1", "collection-1-secret"),
		).toEqual(VERIFIED);
	});

	it("keeps the generic failure without logging errors for a missing hash", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const verifyCollectionPassword = await loadAction();

		expect(await verifyCollectionPassword("collection-open", "x")).toEqual(
			WRONG,
		);
		expect(error).not.toHaveBeenCalled();
	});

	it("limits attempts in production when the firewall check throws", async () => {
		vi.stubEnv("NODE_ENV", "production");
		mocks.checkRateLimit.mockRejectedValue(
			new Error("Could not determine rate limit key."),
		);
		const verifyCollectionPassword = await loadAction();

		for (let attempt = 0; attempt < 20; attempt++) {
			await verifyCollectionPassword("collection-1", "nope");
		}
		expect(
			await verifyCollectionPassword("collection-1", "collection-1-secret"),
		).toEqual(TOO_MANY);
	});
});
