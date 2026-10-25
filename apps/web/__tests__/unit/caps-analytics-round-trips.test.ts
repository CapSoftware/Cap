import { CurrentUser, Organisation, User, Video } from "@cap/web-domain";
import { Cause, Effect, Exit, Logger, LogLevel, Option } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

type AccessFixture = {
	id: string;
	public?: boolean;
	owner?: boolean;
	orgMember?: boolean;
	spaceMember?: boolean;
	password?: string;
	spacePasswords?: string[];
	domain?: string;
	grant?: boolean;
};
const mocks = vi.hoisted(() => ({
	query: vi.fn(),
	latency: 0,
	size: 50,
	owner: false,
	fixtures: null as AccessFixture[] | null,
	failTable: "",
}));
vi.mock("@cap/database", async () => {
	const { drizzle } = await import("drizzle-orm/mysql-proxy");
	return { db: () => drizzle(mocks.query) };
});
vi.mock("@cap/utils", async () => {
	const { isEmailAllowedByRestriction } = await import(
		"../../../../packages/utils/src/helpers"
	);
	return { dub: {}, isEmailAllowedByRestriction };
});
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
		succeed: {
			querySql: () =>
				Effect.succeed({
					data: Array.from({ length: mocks.size }, (_, index) => ({
						pathname: `/s/video-${index}`,
						views: index + 1,
					})),
				}),
		},
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

const user: CurrentUser["Type"] = {
	id: User.UserId.make("viewer"),
	email: "viewer@example.com",
	activeOrganizationId: Organisation.OrganisationId.make("org"),
	iconUrlOrKey: Option.none(),
};
function ids() {
	return Array.from({ length: mocks.size }, (_, index) =>
		Video.VideoId.make(`video-${index}`),
	);
}
function run() {
	return Effect.flatMap(Videos, (videos) =>
		videos.getAnalyticsBulk(ids()),
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
		Effect.runPromise,
	);
}
function reply(sql: string, params: unknown[] = []) {
	if (mocks.failTable && sql.includes(`from \`${mocks.failTable}\``))
		throw new Error("Database unavailable");
	if (mocks.fixtures) {
		const selected = mocks.fixtures.filter((fixture) =>
			params.includes(fixture.id),
		);
		if (sql.includes("from `organization_members`")) {
			expect(params[0]).toBe("viewer");
			return selected
				.filter((fixture) => fixture.orgMember)
				.map((fixture) =>
					sql.includes("`shared_videos`.`videoId`,")
						? [fixture.id, "org-membership"]
						: ["org-membership"],
				);
		}
		if (sql.includes("from `space_members`")) {
			expect(params[0]).toBe("viewer");
			return selected
				.filter((fixture) => fixture.spaceMember)
				.map((fixture) =>
					sql.includes("`space_videos`.`videoId`,")
						? [fixture.id, "space-membership"]
						: ["space-membership"],
				);
		}
		if (sql.includes("from `space_videos`"))
			return selected.flatMap((fixture) =>
				(fixture.spacePasswords ?? []).map((password) =>
					sql.startsWith("select `space_videos`.`videoId`")
						? [fixture.id, password]
						: ["space", "Space", password],
				),
			);
		if (sql.includes("from `organizations`"))
			return mocks.fixtures
				.filter((fixture) => params.includes(`org-${fixture.id}`))
				.map((fixture) => [fixture.domain ?? null]);
		if (sql.includes("from `video_viewer_grants`"))
			return selected.filter((fixture) => fixture.grant).map(() => ["grant"]);
		throw new Error(`Unexpected policy query: ${sql}`);
	}
	if (sql.includes("from `videos`"))
		return ids().map((id) => [
			id,
			"org",
			mocks.owner ? "viewer" : "owner",
			0,
			null,
		]);
	if (sql.includes("from `organization_members`"))
		return sql.includes("`shared_videos`.`videoId`,")
			? ids().map((id) => [id, "membership"])
			: [["membership"]];
	if (
		sql.includes("from `space_members`") ||
		sql.includes("from `space_videos`")
	)
		return [];
	throw new Error(`Unexpected query: ${sql}`);
}
async function countRoundTrips() {
	const pending: Array<() => void> = [];
	mocks.query.mockImplementation(
		(sql: string, params: unknown[]) =>
			new Promise((resolve) =>
				pending.push(() => resolve({ rows: reply(sql, params) })),
			),
	);
	let settled = false;
	const result = run().finally(() => {
		settled = true;
	});
	let rounds = 0;
	let idleTicks = 0;
	while (!settled) {
		const issued = mocks.query.mock.calls.length;
		await new Promise((resolve) => setTimeout(resolve, 0));
		if (mocks.query.mock.calls.length !== issued || pending.length === 0) {
			idleTicks = 0;
			continue;
		}
		if (++idleTicks < 3) continue;
		idleTicks = 0;
		rounds++;
		for (const release of pending.splice(0)) release();
	}
	await result;
	return rounds;
}
function timedQueries() {
	mocks.query.mockImplementation(async (sql: string, params: unknown[]) => {
		if (mocks.latency)
			await new Promise((resolve) => setTimeout(resolve, mocks.latency));
		return { rows: reply(sql, params) };
	});
}
beforeEach(() => {
	mocks.size = 50;
	mocks.fixtures = null;
	mocks.failTable = "";
	mocks.owner = false;
	mocks.latency = 0;
	timedQueries();
});
describe("Caps grid analytics database load", () => {
	it.each([50, 200])("returns every shared count for %i Caps", async (size) => {
		mocks.size = size;
		const results = await run();
		expect(results.map((result) => Exit.getOrElse(result, () => null))).toEqual(
			ids().map((_, index) => ({ count: index + 1 })),
		);
		expect(mocks.query).toHaveBeenCalledTimes(4);
	});
	it("keeps owner analytics to one query", async () => {
		mocks.owner = true;
		await run();
		expect(mocks.query).toHaveBeenCalledTimes(1);
	});
	it.skipIf(!process.env.CAP_BENCH_CAPS_ANALYTICS)(
		"measures 20 ms database latency for My Caps and Shared Caps",
		async () => {
			for (const owner of [true, false]) {
				for (const size of [15, 50, 200]) {
					mocks.owner = owner;
					mocks.size = size;
					mocks.latency = 20;
					const rounds = await countRoundTrips();
					timedQueries();
					const times: number[] = [];
					let queries = 0;
					for (let iteration = 0; iteration < 7; iteration++) {
						mocks.query.mockClear();
						const start = performance.now();
						const results = await run();
						times.push(performance.now() - start);
						queries = mocks.query.mock.calls.length;
						expect(results.every(Exit.isSuccess)).toBe(true);
					}
					times.sort((a, b) => a - b);
					console.log(
						JSON.stringify({
							owner,
							size,
							queries,
							rounds,
							medianMs: times[3],
						}),
					);
				}
			}
		},
	);
});

const fixtures: AccessFixture[] = [
	{
		id: "owned",
		owner: true,
		password: "video-hash",
		spacePasswords: ["space-hash"],
	},
	{ id: "org-member", orgMember: true },
	{ id: "space-member", spaceMember: true },
	{ id: "public", public: true },
	{ id: "private" },
	{ id: "protected", orgMember: true, password: "video-hash" },
	{
		id: "inherited",
		spaceMember: true,
		spacePasswords: ["space-hash", "other-hash"],
	},
	{ id: "invited", grant: true },
	{ id: "restricted", public: true, domain: "example.com" },
	{ id: "denied-domain", public: true, domain: "other.com" },
	{ id: "domain-invited", public: true, domain: "other.com", grant: true },
];

function runPolicies(
	bulk: boolean,
	authenticated = true,
	passwords: string[] = [],
) {
	const loaded = (mocks.fixtures ?? []).map(
		(fixture) =>
			[
				{
					id: Video.VideoId.make(fixture.id),
					orgId: Organisation.OrganisationId.make(`org-${fixture.id}`),
					ownerId: User.UserId.make(fixture.owner ? "viewer" : "owner"),
					public: fixture.public ?? false,
				},
				Option.fromNullable(fixture.password),
			] as const,
	);
	const program = Effect.flatMap(VideosPolicy, (policy) =>
		bulk
			? policy.canViewLoadedBulk(loaded)
			: Effect.forEach(loaded, ([video, password]) =>
					policy.canViewLoaded(video, password).pipe(Effect.exit),
				),
	);
	const withUser = authenticated
		? program.pipe(Effect.provideService(CurrentUser, user))
		: program;
	return withUser.pipe(
		Effect.provide(VideosPolicy.Default),
		Effect.provideService(Video.VideoPasswordAttachment, { passwords }),
		Logger.withMinimumLogLevel(LogLevel.None),
		Effect.map((results) =>
			results.map((result) =>
				Exit.isSuccess(result)
					? "allowed"
					: Option.getOrThrow(Cause.failureOption(result.cause))._tag,
			),
		),
		Effect.runPromise,
	);
}

describe("batched Caps access parity", () => {
	it.each([
		{ authenticated: true, passwords: [] },
		{ authenticated: false, passwords: [] },
		{ authenticated: true, passwords: ["video-hash", "other-hash"] },
		{ authenticated: false, passwords: ["video-hash", "other-hash"] },
		{ authenticated: true, passwords: ["wrong-hash"] },
	])(
		"matches individual policies for $authenticated and $passwords",
		async ({ authenticated, passwords }) => {
			mocks.fixtures = fixtures;
			const single = await runPolicies(false, authenticated, passwords);
			expect(await runPolicies(true, authenticated, passwords)).toEqual(single);
		},
	);

	it.each(["space_videos", "organization_members", "space_members"])(
		"preserves per-video failures from %s",
		async (table) => {
			mocks.fixtures = fixtures;
			mocks.failTable = table;
			const single = await runPolicies(false);
			expect(single[0]).toBe("allowed");
			expect(single.slice(1)).toContain("DatabaseError");
			expect(await runPolicies(true)).toEqual(single);
		},
	);

	it("rechecks access after membership and passwords change", async () => {
		mocks.fixtures = [{ id: "shared", spaceMember: true }];
		expect(await runPolicies(true)).toEqual(["allowed"]);
		mocks.fixtures = [{ id: "shared" }];
		expect(await runPolicies(true)).toEqual(["PolicyDenied"]);
		mocks.fixtures = [
			{ id: "shared", spaceMember: true, spacePasswords: ["new-hash"] },
		];
		expect(await runPolicies(true)).toEqual(["VerifyVideoPasswordError"]);
	});

	it("does not query an empty policy batch", async () => {
		mocks.fixtures = [];
		expect(await runPolicies(true)).toEqual([]);
		expect(mocks.query).not.toHaveBeenCalled();
	});
});
