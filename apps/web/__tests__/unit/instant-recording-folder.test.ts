import {
	CurrentUser,
	Folder,
	Organisation,
	Policy,
	User,
} from "@cap/web-domain";
import { Effect, Exit, Logger, LogLevel, Option } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	query: vi.fn(),
	writableAccess: vi.fn(),
}));

vi.mock("@cap/database", async () => {
	const { drizzle } = await import("drizzle-orm/mysql-proxy");
	return { db: () => drizzle(mocks.query) };
});
vi.mock("@cap/utils", () => ({ dub: {} }));
vi.mock("@cap/web-backend/src/Storage/index", async () => {
	const { Effect } = await import("effect");
	class Storage extends Effect.Service<Storage>()("Storage", {
		sync: () => ({
			getWritableAccessForUser: (...args: unknown[]) => {
				mocks.writableAccess(...args);
				return Effect.fail(new StorageReached());
			},
		}),
	}) {}
	class StorageReached {
		readonly _tag = "StorageReached";
	}
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

const orgId = Organisation.OrganisationId.make("org-1");
const folderId = Folder.FolderId.make("folder-1");
const user: CurrentUser["Type"] = {
	id: User.UserId.make("user-1"),
	email: "user@example.com",
	activeOrganizationId: orgId,
	iconUrlOrKey: Option.none(),
};

function create(folder: Option.Option<Folder.FolderId>) {
	return Effect.flatMap(Videos, (videos) =>
		videos.createInstantRecording({ orgId, folderId: folder }),
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

function failureTag(exit: Exit.Exit<unknown, unknown>) {
	if (Exit.isSuccess(exit)) return null;
	const failure = exit.cause._tag === "Fail" ? exit.cause.error : null;
	return failure && typeof failure === "object" && "_tag" in failure
		? failure._tag
		: null;
}

function folderLookups() {
	return mocks.query.mock.calls.filter(([query]) =>
		String(query).includes("from `folders`"),
	);
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("createInstantRecording folder placement", () => {
	it("accepts the caller's own personal folder in the active organization", async () => {
		mocks.query.mockResolvedValue({ rows: [[folderId]] });

		const exit = await create(Option.some(folderId));

		expect(failureTag(exit)).toBe("StorageReached");
		expect(mocks.writableAccess).toHaveBeenCalledWith(user.id, orgId);
		const [lookup] = folderLookups();
		expect(String(lookup?.[0])).toContain("`folders`.`spaceId` is null");
		expect(lookup?.[1]).toEqual([folderId, orgId, user.id, 1]);
	});

	it("refuses a folder that is not the caller's personal folder in that organization", async () => {
		mocks.query.mockResolvedValue({ rows: [] });

		const exit = await create(Option.some(folderId));

		expect(failureTag(exit)).toBe(new Policy.PolicyDeniedError()._tag);
		expect(mocks.writableAccess).not.toHaveBeenCalled();
		expect(
			mocks.query.mock.calls.some(([query]) =>
				String(query).startsWith("insert"),
			),
		).toBe(false);
	});

	it("skips the folder lookup when no folder is requested", async () => {
		const exit = await create(Option.none());

		expect(failureTag(exit)).toBe("StorageReached");
		expect(folderLookups()).toHaveLength(0);
		expect(mocks.writableAccess).toHaveBeenCalledTimes(1);
	});
});
