import type { notifications } from "@cap/database/schema";
import type { ImageUploads as ImageUploadsService } from "@cap/web-backend";
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	query: vi.fn(),
	getCurrentUser: vi.fn(),
	resolveImageUrl: vi.fn(),
	latency: 0,
}));

vi.mock("@cap/database", async () => {
	const { drizzle } = await import("drizzle-orm/mysql-proxy");
	return { db: () => drizzle(mocks.query) };
});
vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: mocks.getCurrentUser,
}));
vi.mock("@cap/web-backend", async () => {
	const { Effect } = await import("effect");
	class ImageUploads extends Effect.Service<ImageUploads>()("ImageUploads", {
		succeed: { resolveImageUrl: mocks.resolveImageUrl },
	}) {}
	return { ImageUploads };
});
vi.mock("@/lib/server", async () => {
	const { ImageUploads } = await import("@cap/web-backend");
	const { Effect } = await import("effect");
	return {
		runPromise: <A, E>(effect: Effect.Effect<A, E, ImageUploadsService>) =>
			Effect.runPromise(Effect.provide(effect, ImageUploads.Default)),
	};
});

import { GET } from "@/app/api/notifications/route";

type NotificationRow = typeof notifications.$inferSelect;
type Fixture = Pick<NotificationRow, "id" | "type" | "data"> & {
	author: { id: string; name: string | null; avatar: string | null } | null;
	readAt: string | null;
};

const createdAt = "2026-10-26 01:00:00";
const types = ["view", "comment", "reply", "reaction", "anon_view"] as const;

function fixtures(size: number): Fixture[] {
	return Array.from({ length: size }, (_, index) => {
		const type = types[index % types.length] ?? "view";
		const authorId = index === 0 ? "deleted-author" : `author-${index % 5}`;
		return {
			id: `notification-${index}`,
			type,
			data: {
				videoId: `video-${index % 10}`,
				authorId,
				...(type === "comment" || type === "reply" || type === "reaction"
					? { comment: { id: `comment-${index}`, content: `message ${index}` } }
					: {}),
				...(type === "anon_view" && index % 2 === 0
					? { anonName: "Curious Fox", location: "London" }
					: {}),
			},
			author:
				type === "anon_view" || index === 0
					? null
					: {
							id: authorId,
							name: index % 5 === 0 ? null : "Viewer",
							avatar: index % 5 === 0 ? null : "avatars/viewer.png",
						},
			readAt: index >= size / 2 ? createdAt : null,
		};
	});
}

function serve(rows: Fixture[]) {
	mocks.query.mockImplementation(async (query: string, params: unknown[]) => {
		expect(params).toEqual(
			query.includes("left join")
				? ["anon_view", "$.authorId", "user-1", "org-1"]
				: ["user-1", "org-1"],
		);
		expect(query).toContain("`notifications`.`recipientId` = ?");
		expect(query).toContain("`notifications`.`orgId` = ?");
		if (mocks.latency)
			await new Promise((resolve) => setTimeout(resolve, mocks.latency));
		if (query.includes("group by")) {
			return {
				rows: types.map((type) => [
					type,
					String(rows.filter((row) => row.type === type).length),
				]),
			};
		}
		expect(query).toContain("left join `users`");
		expect(query).toContain("order by `notifications`.`readAt` is null desc");
		return {
			rows: rows.map((row) => [
				row.id,
				row.type,
				row.data,
				row.readAt,
				createdAt,
				row.author?.id ?? null,
				row.author?.name ?? null,
				row.author?.avatar ?? null,
			]),
		};
	});
}

function expected(rows: Fixture[], avatarFailed = false) {
	return {
		notifications: rows
			.map((row) => {
				const base = {
					id: row.id,
					type: row.type,
					videoId: row.data.videoId,
					readAt: row.readAt ? "2026-10-26T01:00:00.000Z" : null,
					createdAt: "2026-10-26T01:00:00.000Z",
				};
				if (row.type === "anon_view")
					return {
						...base,
						anonName: row.data.anonName ?? "Anonymous Viewer",
						location: row.data.location ?? null,
					};
				if (!row.author) return null;
				return {
					...base,
					...(row.data.comment ? { comment: row.data.comment } : {}),
					author: {
						id: row.author.id,
						name: row.author.name ?? "Unknown",
						avatar:
							row.author.avatar && !avatarFailed
								? "https://signed.test/avatar"
								: null,
					},
				};
			})
			.filter(Boolean),
		count: {
			view: rows.filter(
				(row) => row.type === "view" || row.type === "anon_view",
			).length,
			comment: rows.filter((row) => row.type === "comment").length,
			reply: rows.filter((row) => row.type === "reply").length,
			reaction: rows.filter((row) => row.type === "reaction").length,
		},
	};
}

beforeEach(() => {
	mocks.latency = 0;
	mocks.getCurrentUser.mockResolvedValue({
		id: "user-1",
		activeOrganizationId: "org-1",
	});
	mocks.resolveImageUrl.mockImplementation(() =>
		Effect.succeed("https://signed.test/avatar"),
	);
});

describe("notification dropdown load", () => {
	it.each([0, 50, 100, 200])(
		"preserves the response for %i notifications in one database round trip",
		async (size) => {
			const rows = fixtures(size);
			serve(rows);
			const response = await GET();
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual(expected(rows));
			expect(mocks.query).toHaveBeenCalledTimes(1);
		},
	);

	it("keeps notifications and counts when avatar signing fails", async () => {
		const rows = fixtures(50);
		serve(rows);
		mocks.resolveImageUrl.mockImplementation(() =>
			Effect.fail(new Error("Signing failed")),
		);
		expect(await (await GET()).json()).toEqual(expected(rows, true));
	});

	it("does not read notifications for an unauthenticated request", async () => {
		mocks.getCurrentUser.mockResolvedValue(null);
		expect((await GET()).status).toBe(401);
		expect(mocks.query).not.toHaveBeenCalled();
	});

	it("returns an error if the database read fails", async () => {
		mocks.query.mockRejectedValue(new Error("Database unavailable"));
		vi.spyOn(console, "error").mockImplementation(() => {});
		const response = await GET();
		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({
			error: "Failed to fetch notifications",
		});
	});

	it.skipIf(!process.env.CAP_BENCH_NOTIFICATIONS)(
		"measures dropdown load with simulated database latency",
		async () => {
			for (const latency of [20, 50]) {
				mocks.latency = latency;
				for (const size of [50, 100, 200]) {
					const rows = fixtures(size);
					serve(rows);
					const times: number[] = [];
					let queries = 0;
					for (let iteration = 0; iteration < 21; iteration++) {
						mocks.query.mockClear();
						const start = performance.now();
						const response = await GET();
						times.push(performance.now() - start);
						expect(await response.json()).toEqual(expected(rows));
						queries = mocks.query.mock.calls.length;
					}
					times.sort((a, b) => a - b);
					console.log(
						JSON.stringify({ latency, size, queries, medianMs: times[10] }),
					);
				}
			}
		},
	);
});
