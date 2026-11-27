import { Context, Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@cap/database", async () => {
	const { drizzle } = await import("drizzle-orm/mysql-proxy");
	const client = drizzle(mocks.query);
	return { db: () => client };
});
vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: async () => ({ id: "viewer", activeOrganizationId: "org-1" }),
}));
vi.mock("@cap/web-backend", async () => {
	const { Context } = await import("effect");
	return { ImageUploads: Context.GenericTag("NotificationsImages") };
});
vi.mock("@/lib/server", () => ({
	runPromise: <A, E>(effect: Effect.Effect<A, E, unknown>) =>
		effect.pipe(
			Effect.provideService(Context.GenericTag("NotificationsImages"), {
				resolveImageUrl: (url: string) => Effect.succeed(`signed:${url}`),
			}),
			Effect.runPromise,
		),
}));

import { GET } from "@/app/api/notifications/route";

const createdAt = "2026-11-01 10:00:00";

function rowsFor(query: string) {
	if (query.includes("COUNT(*)"))
		return [
			["comment", 2],
			["view", 1],
			["anon_view", 3],
		];
	return [
		[
			"notification-1",
			"comment",
			{
				videoId: "video-1",
				authorId: "author-1",
				comment: { id: "comment-1", content: "Nice" },
			},
			null,
			createdAt,
			"author-1",
			"Author",
			"avatar.png",
		],
		[
			"notification-2",
			"anon_view",
			{ videoId: "video-1", anonName: "Fox", location: null },
			null,
			createdAt,
			null,
			null,
			null,
		],
	];
}

beforeEach(() => mocks.query.mockReset());

describe("GET /api/notifications", () => {
	it("issues the list and count queries in one round trip", async () => {
		const pending: Array<() => void> = [];
		const bothIssued = Promise.withResolvers<void>();
		mocks.query.mockImplementation(
			(query: string) =>
				new Promise((resolve) => {
					pending.push(() => resolve({ rows: rowsFor(query) }));
					if (pending.length === 2) bothIssued.resolve();
				}),
		);

		const response = GET();
		await bothIssued.promise;
		for (const release of pending.splice(0)) release();
		const body = await (await response).json();

		expect(mocks.query).toHaveBeenCalledTimes(2);
		expect(body.count).toEqual({ view: 4, comment: 2, reply: 0, reaction: 0 });
		expect(body.notifications).toEqual([
			expect.objectContaining({
				id: "notification-1",
				type: "comment",
				author: { id: "author-1", name: "Author", avatar: "signed:avatar.png" },
			}),
			expect.objectContaining({
				id: "notification-2",
				type: "anon_view",
				anonName: "Fox",
			}),
		]);
	});
});
