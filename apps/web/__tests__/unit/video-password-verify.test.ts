import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	headers: vi.fn(),
	checkRateLimit: vi.fn(),
	setVerifiedPasswordCookie: vi.fn(),
	verifyPassword: vi.fn(),
	videoRows: vi.fn(),
	spacePasswordRows: vi.fn(),
}));

vi.mock("next/headers", () => ({ headers: mocks.headers }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@vercel/firewall", () => ({ checkRateLimit: mocks.checkRateLimit }));
vi.mock("@cap/database/auth/session", () => ({ getCurrentUser: vi.fn() }));
vi.mock("@cap/database/crypto", () => ({
	hashPassword: vi.fn(),
	verifyPassword: mocks.verifyPassword,
}));
vi.mock("@cap/database/schema", () => ({
	spaces: { password: "spaces.password", id: "spaces.id" },
	spaceVideos: {
		spaceId: "spaceVideos.spaceId",
		videoId: "spaceVideos.videoId",
	},
	videos: { id: "videos.id" },
}));
vi.mock("@cap/database", () => ({
	db: () => ({
		select: () => ({
			from: () => ({
				where: () => mocks.videoRows(),
				innerJoin: () => ({ where: () => mocks.spacePasswordRows() }),
			}),
		}),
	}),
}));
vi.mock("@cap/web-backend", () => ({
	collectPasswordHashes: ({
		videoPassword,
		spacePasswords,
	}: {
		videoPassword?: string | null;
		spacePasswords: Array<{ password?: string | null }>;
	}) =>
		[videoPassword, ...spacePasswords.map(({ password }) => password)].filter(
			(hash): hash is string => typeof hash === "string",
		),
}));
vi.mock("@/lib/password-cookie", () => ({
	setVerifiedPasswordCookie: mocks.setVerifiedPasswordCookie,
}));

const TOO_MANY = {
	success: false,
	error: "Too many attempts. Please try again later.",
};
const WRONG = { success: false, error: "Failed to verify password" };
const VERIFIED = { success: true, value: "Password verified" };

const loadAction = async () => {
	vi.resetModules();
	return (await import("@/actions/videos/password")).verifyVideoPassword;
};

const fromIp = (ip: string) =>
	mocks.headers.mockResolvedValue(new Headers({ "x-real-ip": ip }));

beforeEach(() => {
	mocks.headers.mockReset();
	mocks.setVerifiedPasswordCookie.mockReset();
	mocks.verifyPassword
		.mockReset()
		.mockImplementation(
			async (hash: string, password: string) => hash === `hash:${password}`,
		);
	mocks.videoRows
		.mockReset()
		.mockImplementation(async () => [{ id: "video-1", password: "hash:open" }]);
	mocks.spacePasswordRows.mockReset().mockResolvedValue([]);
	vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.stubEnv("VERCEL", "1");
	fromIp("203.0.113.1");
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("verifyVideoPassword attempt limits", () => {
	it("verifies a correct password and sets the cookie", async () => {
		const verifyVideoPassword = await loadAction();

		expect(await verifyVideoPassword("video-1" as never, "open")).toEqual(
			VERIFIED,
		);
		expect(mocks.setVerifiedPasswordCookie).toHaveBeenCalledWith("hash:open");
	});

	it("stops verifying after repeated attempts from one client", async () => {
		const verifyVideoPassword = await loadAction();

		for (let attempt = 0; attempt < 20; attempt++) {
			expect(await verifyVideoPassword("video-1" as never, "nope")).toEqual(
				WRONG,
			);
		}
		mocks.verifyPassword.mockClear();
		mocks.videoRows.mockClear();

		expect(await verifyVideoPassword("video-1" as never, "open")).toEqual(
			TOO_MANY,
		);
		expect(mocks.videoRows).not.toHaveBeenCalled();
		expect(mocks.verifyPassword).not.toHaveBeenCalled();
		expect(mocks.setVerifiedPasswordCookie).not.toHaveBeenCalled();

		fromIp("203.0.113.2");
		expect(await verifyVideoPassword("video-1" as never, "open")).toEqual(
			VERIFIED,
		);
	});

	it("stops verifying one video after many attempts across clients", async () => {
		const verifyVideoPassword = await loadAction();

		for (let client = 0; client < 11; client++) {
			fromIp(`198.51.100.${client}`);
			for (let attempt = 0; attempt < 20; attempt++) {
				await verifyVideoPassword("video-1" as never, "nope");
			}
		}

		fromIp("192.0.2.200");
		expect(await verifyVideoPassword("video-1" as never, "nope")).toEqual(
			WRONG,
		);
		mocks.verifyPassword.mockClear();
		expect(await verifyVideoPassword("video-1" as never, "open")).toEqual(
			TOO_MANY,
		);
		expect(mocks.verifyPassword).not.toHaveBeenCalled();
		expect(mocks.setVerifiedPasswordCookie).not.toHaveBeenCalled();

		mocks.videoRows.mockResolvedValue([
			{ id: "video-2", password: "hash:other" },
		]);
		expect(await verifyVideoPassword("video-2" as never, "other")).toEqual(
			VERIFIED,
		);
	});

	it("shares the per-video budget across id casing", async () => {
		const verifyVideoPassword = await loadAction();

		for (let client = 0; client < 11; client++) {
			fromIp(`198.51.100.${client}`);
			for (let attempt = 0; attempt < 20; attempt++) {
				await verifyVideoPassword(
					(attempt % 2 === 0 ? "video-1" : "VIDEO-1") as never,
					"nope",
				);
			}
		}

		fromIp("192.0.2.200");
		expect(await verifyVideoPassword("Video-1" as never, "nope")).toEqual(
			WRONG,
		);
		mocks.verifyPassword.mockClear();
		expect(await verifyVideoPassword("Video-1" as never, "open")).toEqual(
			TOO_MANY,
		);
		expect(mocks.verifyPassword).not.toHaveBeenCalled();
	});

	it("still verifies a new visitor's password after many attempts across clients", async () => {
		const verifyVideoPassword = await loadAction();

		for (let client = 0; client < 11; client++) {
			fromIp(`198.51.100.${client}`);
			for (let attempt = 0; attempt < 20; attempt++) {
				await verifyVideoPassword("video-1" as never, "nope");
			}
		}

		fromIp("192.0.2.200");
		expect(await verifyVideoPassword("video-1" as never, "open")).toEqual(
			VERIFIED,
		);
		expect(mocks.setVerifiedPasswordCookie).toHaveBeenCalledWith("hash:open");
	});

	it("gives one IPv6 network a single attempt outside the per-video budget", async () => {
		const verifyVideoPassword = await loadAction();

		for (let client = 0; client < 11; client++) {
			fromIp(`198.51.100.${client}`);
			for (let attempt = 0; attempt < 20; attempt++) {
				await verifyVideoPassword("video-1" as never, "nope");
			}
		}

		fromIp("2001:db8:5:6::1");
		expect(await verifyVideoPassword("video-1" as never, "nope")).toEqual(
			WRONG,
		);
		fromIp("2001:db8:5:6::2");
		expect(await verifyVideoPassword("video-1" as never, "open")).toEqual(
			TOO_MANY,
		);
	});

	it("rejects ids outside the id alphabet before any lookup", async () => {
		const verifyVideoPassword = await loadAction();

		expect(await verifyVideoPassword("video-1 " as never, "open")).toEqual(
			WRONG,
		);
		expect(mocks.videoRows).not.toHaveBeenCalled();
		expect(mocks.verifyPassword).not.toHaveBeenCalled();
	});

	it("does not count attempts rejected per client against the video", async () => {
		const verifyVideoPassword = await loadAction();

		for (let attempt = 0; attempt < 500; attempt++) {
			await verifyVideoPassword("video-1" as never, "nope");
		}

		fromIp("192.0.2.200");
		expect(await verifyVideoPassword("video-1" as never, "open")).toEqual(
			VERIFIED,
		);
	});

	it("keeps the generic failure for videos without a password", async () => {
		mocks.videoRows.mockResolvedValue([{ id: "video-3", password: null }]);
		const verifyVideoPassword = await loadAction();

		expect(await verifyVideoPassword("video-3" as never, "anything")).toEqual(
			WRONG,
		);
		expect(mocks.setVerifiedPasswordCookie).not.toHaveBeenCalled();
	});

	it("limits attempts in production when the firewall rule is missing", async () => {
		vi.stubEnv("NODE_ENV", "production");
		mocks.checkRateLimit.mockResolvedValue({
			rateLimited: false,
			error: "not-found",
		});
		const verifyVideoPassword = await loadAction();

		for (let attempt = 0; attempt < 20; attempt++) {
			await verifyVideoPassword("video-1" as never, "nope");
		}
		expect(await verifyVideoPassword("video-1" as never, "open")).toEqual(
			TOO_MANY,
		);
	});
});
