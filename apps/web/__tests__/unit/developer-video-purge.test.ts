import { MySqlDialect } from "drizzle-orm/mysql-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	rows: [] as { id: string; appId: string }[],
	where: undefined as unknown,
	updates: [] as { set: Record<string, unknown>; id: string }[],
	deleteObjects: vi.fn(),
}));

vi.mock("@cap/database", () => ({
	db: () => ({
		select: () => ({
			from: () => ({
				innerJoin: () => ({
					where: (where: unknown) => {
						mocks.where = where;
						return {
							orderBy: () => ({ limit: async () => mocks.rows }),
						};
					},
				}),
			}),
		}),
		update: () => ({
			set: (set: Record<string, unknown>) => ({
				where: async (where: unknown) => {
					const rendered = new MySqlDialect().sqlToQuery(where as never);
					mocks.updates.push({ set, id: String(rendered.params[0]) });
				},
			}),
		}),
	}),
}));
vi.mock("@/lib/developer-video-storage", () => ({
	deleteDeveloperVideoObjects: mocks.deleteObjects,
	developerVideoPrefix: (video: { appId: string; id: string }) =>
		`developer/${video.appId}/${video.id}/`,
}));

const { purgeDeletedDeveloperVideos } = await import(
	"@/lib/developer-video-purge"
);

beforeEach(() => {
	mocks.rows = [];
	mocks.updates = [];
	mocks.deleteObjects.mockReset();
	mocks.deleteObjects.mockResolvedValue(4);
	vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("deleted developer video purge", () => {
	it("deletes each deleted video's folder and records when", async () => {
		mocks.rows = [
			{ id: "video-1", appId: "app-1" },
			{ id: "video-2", appId: "app-1" },
		];

		expect(await purgeDeletedDeveloperVideos()).toEqual({
			purged: 2,
			failed: 0,
		});
		expect(mocks.deleteObjects.mock.calls).toEqual([
			["developer/app-1/video-1/"],
			["developer/app-1/video-2/"],
		]);
		expect(mocks.updates.map((update) => update.id)).toEqual([
			"video-1",
			"video-2",
		]);
		expect(mocks.updates[0]?.set.filesDeletedAt).toBeInstanceOf(Date);
	});

	it("leaves a video to retry when its files could not be deleted", async () => {
		mocks.rows = [
			{ id: "video-1", appId: "app-1" },
			{ id: "video-2", appId: "app-1" },
		];
		mocks.deleteObjects.mockRejectedValueOnce(new Error("storage down"));

		expect(await purgeDeletedDeveloperVideos()).toEqual({
			purged: 1,
			failed: 1,
		});
		expect(mocks.updates.map((update) => update.id)).toEqual(["video-2"]);
	});

	it("selects deleted videos and videos of deleted apps, plus one late pass", () => {
		void purgeDeletedDeveloperVideos();
		const { sql } = new MySqlDialect().sqlToQuery(mocks.where as never);
		const deletedAt =
			"COALESCE(`developer_videos`.`deletedAt`, `developer_apps`.`deletedAt`)";
		expect(sql).toContain(
			"(`developer_videos`.`deletedAt` is not null or `developer_apps`.`deletedAt` is not null)",
		);
		expect(sql).toContain("`developer_videos`.`filesDeletedAt` is null");
		expect(sql).toContain(
			`\`developer_videos\`.\`filesDeletedAt\` < ${deletedAt} + INTERVAL 4 HOUR`,
		);
		expect(sql).toContain(`${deletedAt} <= NOW() - INTERVAL 4 HOUR`);
	});
});
