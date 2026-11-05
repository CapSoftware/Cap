import * as Db from "@cap/database/schema";
import { CurrentUser, Organisation, User, Video } from "@cap/web-domain";
import { getTableColumns } from "drizzle-orm";
import { Effect, Exit, Logger, LogLevel, Option } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@cap/database", async () => {
	const { drizzle } = await import("drizzle-orm/mysql-proxy");
	const database = drizzle(mocks.query);
	return {
		db: () =>
			Object.assign(database, {
				transaction: async (run: (tx: typeof database) => Promise<unknown>) =>
					run(database),
			}),
	};
});
vi.mock("@cap/utils", () => ({ dub: {} }));
vi.mock("@cap/web-backend/src/Storage/index", async () => {
	const { Effect } = await import("effect");
	class Storage extends Effect.Service<Storage>()("Storage", {
		sync: () => ({}),
	}) {}
	return { Storage };
});
vi.mock("@cap/web-backend/src/Tinybird/index", async () => {
	const { Effect } = await import("effect");
	class Tinybird extends Effect.Service<Tinybird>()("Tinybird", {
		sync: () => ({}),
	}) {}
	return { Tinybird };
});

const { Videos } = await import("@cap/web-backend/src/Videos/index");
const { VideosPolicy } = await import(
	"@cap/web-backend/src/Videos/VideosPolicy"
);
const { VideosRepo } = await import("@cap/web-backend/src/Videos/VideosRepo");
const { Database } = await import("@cap/web-backend/src/Database");
const { Storage } = await import("@cap/web-backend/src/Storage/index");
const { Tinybird } = await import("@cap/web-backend/src/Tinybird/index");

const videoId = Video.VideoId.make("video-1");
const ownerId = User.UserId.make("owner-1");
const user: CurrentUser["Type"] = {
	id: ownerId,
	email: "owner@example.com",
	activeOrganizationId: Organisation.OrganisationId.make("org-1"),
	iconUrlOrKey: Option.none(),
};
const updatedAt = new Date("2026-11-05T12:00:00Z");

function update() {
	return Effect.flatMap(Videos, (videos) =>
		videos.updateUploadProgress({
			videoId,
			uploaded: 40,
			total: 100,
			updatedAt,
		}),
	).pipe(
		Effect.provide(Videos.DefaultWithoutDependencies),
		Effect.provide([
			VideosPolicy.Default,
			VideosRepo.Default,
			Storage.Default,
			Tinybird.Default,
			Database.Default,
		]),
		Effect.provideService(CurrentUser, user),
		Logger.withMinimumLogLevel(LogLevel.None),
		Effect.runPromiseExit,
	);
}

function serveVideo({
	owner = ownerId,
	phase = null,
	missing = false,
}: {
	owner?: User.UserId;
	phase?: typeof Db.videoUploads.$inferSelect.phase | null;
	missing?: boolean;
} = {}) {
	const video: Record<string, unknown> = { id: videoId, ownerId: owner };
	const upload: Record<string, unknown> = {
		videoId,
		phase,
		uploaded: 20,
		total: 100,
		updatedAt: "2026-11-05 11:59:00",
	};
	mocks.query.mockImplementation(async (sql: string) => {
		if (!sql.startsWith("select"))
			return { rows: [{ insertId: 0, affectedRows: 1 }] };
		const row = Object.keys(getTableColumns(Db.videos)).map(
			(key) => video[key] ?? null,
		);
		if (sql.includes("left join")) {
			row.push(
				...Object.keys(getTableColumns(Db.videoUploads)).map((key) =>
					phase ? (upload[key] ?? null) : null,
				),
			);
		}
		return {
			rows: missing ? [] : [sql.startsWith("select `ownerId`") ? [owner] : row],
		};
	});
}

const writes = () =>
	mocks.query.mock.calls.filter(([sql]) => !String(sql).startsWith("select"));

beforeEach(() => {
	vi.clearAllMocks();
	serveVideo();
});

describe("upload progress lifecycle", () => {
	it("acknowledges delayed progress after completion without recreating an upload", async () => {
		expect(await update()).toEqual(Exit.succeed(true));
		expect(writes().some(([sql]) => String(sql).startsWith("insert"))).toBe(
			false,
		);
	});

	it("updates upload bytes only while the upload is still uploading", async () => {
		serveVideo({ phase: "uploading" });
		expect(await update()).toEqual(Exit.succeed(true));
		const [write] = writes();
		expect(write?.[0]).toContain("update `video_uploads`");
		expect(String(write?.[0]).split(" where ")[1]).toContain(
			"`video_uploads`.`phase` = ?",
		);
		expect(write?.[1]).toContain("uploading");
		expect(write?.[0]).toContain("`video_uploads`.`updated_at` <= ?");
		expect(write?.[1]).toContain("2026-11-05 12:00:00.000");
	});

	it.each(["processing", "generating_thumbnail", "complete", "error"] as const)(
		"does not overwrite %s progress even if the client timestamp is newer",
		async (phase) => {
			serveVideo({ phase });
			expect(await update()).toEqual(Exit.succeed(true));
			for (const [sql, params] of writes()) {
				expect(String(sql).split(" where ")[1]).toContain(
					"`video_uploads`.`phase` = ?",
				);
				expect(params).toContain("uploading");
			}
		},
	);

	it("rejects another owner's video before writing progress", async () => {
		serveVideo({ owner: User.UserId.make("other-owner") });
		expect(Exit.isFailure(await update())).toBe(true);
		expect(writes()).toEqual([]);
	});

	it("rejects a missing video before writing progress", async () => {
		serveVideo({ missing: true });
		expect(Exit.isFailure(await update())).toBe(true);
		expect(writes()).toEqual([]);
	});
});
