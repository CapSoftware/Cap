import { CurrentUser, Organisation, User, Video } from "@cap/web-domain";
import { Effect, Exit, Option } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	rows: [] as Record<string, unknown>[],
	select: vi.fn(),
	query: vi.fn(),
	readError: undefined as Error | undefined,
}));

vi.mock("@cap/database", () => ({
	db: () => ({
		select: (columns: unknown) => {
			mocks.select(columns);
			return {
				from: () => ({
					where: async () => {
						if (mocks.readError) throw mocks.readError;
						return mocks.rows;
					},
				}),
			};
		},
	}),
}));
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
		sync: () => ({
			querySql: (sql: string) => {
				mocks.query(sql);
				return Effect.succeed({
					data: [{ pathname: "/s/owned", views: 12 }],
				});
			},
		}),
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
const { Policy } = await import("@cap/web-domain");
const check = vi.fn((video: { id: string }) =>
	video.id === "denied"
		? Effect.fail(new Policy.PolicyDeniedError())
		: video.id === "protected"
			? Effect.fail(
					new Video.VerifyVideoPasswordError({
						id: Video.VideoId.make(video.id),
						cause: "not-provided",
					}),
				)
			: Effect.void,
);
const user: CurrentUser["Type"] = {
	id: User.UserId.make("owner"),
	email: "owner@example.com",
	activeOrganizationId: Organisation.OrganisationId.make("org"),
	iconUrlOrKey: Option.none(),
};

function run(ids: string[]) {
	return Effect.runPromise(
		Effect.flatMap(Videos, (videos) =>
			videos.getAnalyticsBulk(ids.map((id) => Video.VideoId.make(id))),
		).pipe(
			Effect.provide(Videos.DefaultWithoutDependencies),
			Effect.provideService(
				VideosPolicy,
				VideosPolicy.make({
					canViewLoaded: check,
					canView: vi.fn(),
					isOwner: vi.fn(),
					isOwnerLoaded: vi.fn(),
					getViewableById: vi.fn(),
					getOwnedById: vi.fn(),
				}),
			),
			Effect.provide([
				Database.Default,
				VideosRepo.Default,
				Storage.Default,
				Tinybird.Default,
			]),
			Effect.provideService(CurrentUser, user),
		),
	);
}

beforeEach(() => {
	mocks.readError = undefined;
	mocks.rows = ["owned", "denied", "protected"].map((id) => ({
		id,
		ownerId: "owner",
		orgId: "org",
		public: false,
		password: id === "protected" ? "password-hash" : null,
	}));
});

describe("bulk video analytics", () => {
	it("batches lookups and preserves order, duplicates and missing results", async () => {
		const results = await run(["missing", "owned", "owned"]);
		expect(results.map((result) => Exit.getOrElse(result, () => null))).toEqual(
			[{ count: 0 }, { count: 12 }, { count: 12 }],
		);
		expect(mocks.select).toHaveBeenCalledTimes(1);
		expect(mocks.query).toHaveBeenCalledTimes(1);
	});

	it("preserves per-video access and password failures", async () => {
		const results = await run(["denied", "owned", "protected"]);
		expect(results.map((result) => Exit.isFailure(result))).toEqual([
			true,
			false,
			true,
		]);
		expect(results.map((result) => Exit.getOrElse(result, () => null))).toEqual(
			[null, { count: 12 }, null],
		);
		expect(mocks.query.mock.calls[0]?.[0]).not.toContain("/s/denied");
		expect(mocks.query.mock.calls[0]?.[0]).not.toContain("/s/protected");
		expect(check).toHaveBeenCalledWith(
			expect.objectContaining({ id: "protected" }),
			Option.some("password-hash"),
		);
	});

	it("does not read the database for an empty batch", async () => {
		expect(await run([])).toEqual([]);
		expect(mocks.select).not.toHaveBeenCalled();
		expect(mocks.query).not.toHaveBeenCalled();
	});

	it("reports database failures instead of returning zero views", async () => {
		mocks.readError = new Error("Database unavailable");
		await expect(run(["owned"])).rejects.toThrow();
		expect(mocks.query).not.toHaveBeenCalled();
	});
});
