import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	query: vi.fn(),
	getCurrentUser: vi.fn(),
	revalidatePath: vi.fn(),
	crossSite: false,
}));

vi.mock("@cap/database", async () => {
	const { drizzle } = await import("drizzle-orm/mysql-proxy");
	return { db: () => drizzle(mocks.query) };
});
vi.mock("@cap/database/schema", async () => {
	const { mysqlTable, varchar } = await import("drizzle-orm/mysql-core");
	return {
		videos: mysqlTable("videos", {
			id: varchar("id", { length: 15 }).primaryKey(),
			ownerId: varchar("ownerId", { length: 15 }).notNull(),
			transcriptionStatus: varchar("transcriptionStatus", { length: 20 }),
		}),
	};
});
vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: mocks.getCurrentUser,
}));
vi.mock("@cap/database/auth/request-site", () => ({
	isCrossSiteCookieWrite: () => mocks.crossSite,
}));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));

import { POST } from "@/app/api/videos/[videoId]/retry-transcription/route";

type Status =
	| "PROCESSING"
	| "COMPLETE"
	| "ERROR"
	| "SKIPPED"
	| "NO_AUDIO"
	| null;
let status: Status;
let ownerId: string;
let exists: boolean;
let beforeUpdate: (() => void) | undefined;

function retry() {
	return POST(
		new Request("https://cap.so/api/videos/video-1/retry-transcription", {
			method: "POST",
		}),
		{ params: Promise.resolve({ videoId: "video-1" }) },
	);
}

beforeEach(() => {
	status = "ERROR";
	ownerId = "user-1";
	exists = true;
	beforeUpdate = undefined;
	mocks.crossSite = false;
	mocks.getCurrentUser.mockResolvedValue({ id: "user-1" });
	mocks.query.mockImplementation(async (sql: string, params: unknown[]) => {
		if (sql.startsWith("select")) {
			return { rows: exists ? [["video-1", ownerId, status]] : [] };
		}
		beforeUpdate?.();
		const where = sql.slice(sql.indexOf(" where "));
		const expectedStatus = params.at(-1);
		const matchesStatus = where.includes("`transcriptionStatus` is null")
			? status === null
			: !where.includes("`transcriptionStatus` = ?") ||
				status === expectedStatus;
		const matchesOwner =
			!where.includes("`ownerId` = ?") || params.includes(ownerId);
		const matched = matchesStatus && matchesOwner;
		if (matched) status = null;
		return { rows: [{ affectedRows: matched ? 1 : 0, insertId: 0 }] };
	});
});

describe("transcription retries", () => {
	it.each<Status>(["ERROR", "NO_AUDIO", "COMPLETE", null])(
		"keeps manual recovery available for %s",
		async (initialStatus) => {
			status = initialStatus;
			expect((await retry()).status).toBe(200);
			expect(status).toBeNull();
			expect(mocks.revalidatePath).toHaveBeenCalledWith("/s/video-1");
		},
	);

	it("does not release an active transcription claim", async () => {
		status = "PROCESSING";
		expect((await retry()).status).toBe(409);
		expect(status).toBe("PROCESSING");
		expect(mocks.query).toHaveBeenCalledTimes(1);
	});

	it.each<Status>(["PROCESSING", "COMPLETE", "SKIPPED", "NO_AUDIO"])(
		"preserves a %s status published after the retry read",
		async (nextStatus) => {
			beforeUpdate = () => {
				status = nextStatus;
			};
			expect((await retry()).status).toBe(409);
			expect(status).toBe(nextStatus);
			expect(mocks.revalidatePath).not.toHaveBeenCalled();
		},
	);

	it("preserves a workflow claim taken after a timed-out null status was read", async () => {
		status = null;
		beforeUpdate = () => {
			status = "PROCESSING";
		};
		expect((await retry()).status).toBe(409);
		expect(status).toBe("PROCESSING");
	});

	it("does not reset transcription after ownership changes", async () => {
		beforeUpdate = () => {
			ownerId = "user-2";
		};
		expect((await retry()).status).toBe(409);
		expect(status).toBe("ERROR");
	});

	it.each([false, true])(
		"rejects unauthenticated writes, cross-site %s",
		async (crossSite) => {
			mocks.crossSite = crossSite;
			if (!crossSite) mocks.getCurrentUser.mockResolvedValue(null);
			expect((await retry()).status).toBe(401);
			expect(mocks.query).not.toHaveBeenCalled();
		},
	);

	it("rejects another user's video", async () => {
		ownerId = "user-2";
		expect((await retry()).status).toBe(403);
		expect(status).toBe("ERROR");
	});

	it("returns not found for a missing video", async () => {
		exists = false;
		expect((await retry()).status).toBe(404);
	});

	it("reports failed writes without revalidating", async () => {
		beforeUpdate = () => {
			throw new Error("Database unavailable");
		};
		vi.spyOn(console, "error").mockImplementation(() => {});
		expect((await retry()).status).toBe(500);
		expect(status).toBe("ERROR");
		expect(mocks.revalidatePath).not.toHaveBeenCalled();
	});
});
