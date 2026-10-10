import { CurrentUser, Organisation, S3Bucket, User } from "@cap/web-domain";
import { Effect, Option } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	database: vi.fn(),
	bucket: vi.fn(),
	deleted: vi.fn(),
}));
vi.mock("@cap/web-backend/src/Database", async () => {
	const { Effect } = await import("effect");
	class Database extends Effect.Service<Database>()("Database", {
		sync: () => ({ use: mocks.database }),
	}) {}
	return { Database };
});
vi.mock("@cap/web-backend/src/S3Buckets", async () => {
	const { Effect } = await import("effect");
	class S3Buckets extends Effect.Service<S3Buckets>()("S3Buckets", {
		sync: () => ({ getBucketAccess: mocks.bucket }),
	}) {}
	return { S3Buckets };
});
vi.mock("@cap/web-backend/src/ImageUploads", async () => {
	const { Effect } = await import("effect");
	class ImageUploads extends Effect.Service<ImageUploads>()("ImageUploads", {
		sync: () => ({}),
	}) {}
	return { ImageUploads };
});
vi.mock("@cap/web-backend/src/Tinybird", async () => {
	const { Effect } = await import("effect");
	class Tinybird extends Effect.Service<Tinybird>()("Tinybird", {
		sync: () => ({ deleteData: () => Effect.void }),
	}) {}
	return { Tinybird };
});
vi.mock("@cap/web-backend/src/Organisations/OrganisationsPolicy", async () => {
	const { Effect } = await import("effect");
	const { Policy } = await import("@cap/web-domain");
	class OrganisationsPolicy extends Effect.Service<OrganisationsPolicy>()(
		"OrganisationsPolicy",
		{
			sync: () => ({
				isOwner: () => Policy.policy(() => Effect.succeed(true)),
			}),
		},
	) {}
	return { OrganisationsPolicy };
});

import { Organisations } from "@cap/web-backend/src/Organisations";

const cleanup = () =>
	Effect.runPromise(
		Effect.flatMap(Organisations, (organizations) =>
			organizations.softDelete(Organisation.OrganisationId.make("org")),
		).pipe(
			Effect.provide(Organisations.Default),
			Effect.provideService(CurrentUser, {
				id: User.UserId.make("owner"),
				email: "owner@cap.test",
				activeOrganizationId: Organisation.OrganisationId.make("org"),
				iconUrlOrKey: Option.none(),
			}),
		),
	);

beforeEach(() => {
	vi.resetAllMocks();
	mocks.database
		.mockReturnValueOnce(Effect.succeed([{ id: "org", ownerId: "owner" }]))
		.mockReturnValueOnce(
			Effect.succeed([
				{
					id: "virginia",
					ownerId: "owner",
					bucket: null,
					storageIntegrationId: null,
				},
				{
					id: "tokyo",
					ownerId: "owner",
					bucket: S3Bucket.TokyoBucketId,
					storageIntegrationId: null,
				},
				{
					id: "custom",
					ownerId: "owner",
					bucket: "custom-bucket",
					storageIntegrationId: null,
				},
				{
					id: "drive",
					ownerId: "owner",
					bucket: null,
					storageIntegrationId: "drive-id",
				},
			]),
		)
		.mockReturnValue(Effect.void);
	mocks.bucket.mockImplementation((bucket: Option.Option<string>) =>
		Effect.succeed([
			{
				listObjects: ({
					prefix,
					continuationToken,
				}: {
					prefix: string;
					continuationToken?: string;
				}) =>
					Effect.succeed({
						Contents: [{ Key: `${prefix}${continuationToken ?? "first"}` }],
						IsTruncated: !continuationToken,
						NextContinuationToken: "second",
					}),
				deleteObjects: (objects: Array<{ Key: string }>) =>
					Effect.sync(() => mocks.deleted(Option.getOrNull(bucket), objects)),
			},
			Option.none(),
		]),
	);
});

describe("organization regional media cleanup", () => {
	it("deletes both pages in each managed bucket and leaves customer storage alone", async () => {
		await cleanup();
		expect(mocks.deleted.mock.calls).toEqual(
			expect.arrayContaining([
				[null, [{ Key: "owner/virginia/first" }]],
				[null, [{ Key: "owner/virginia/second" }]],
				["cap-tokyo", [{ Key: "owner/tokyo/first" }]],
				["cap-tokyo", [{ Key: "owner/tokyo/second" }]],
				[null, [{ Key: "organizations/org/first" }]],
				[null, [{ Key: "organizations/org/second" }]],
			]),
		);
		expect(mocks.deleted).toHaveBeenCalledTimes(6);
		expect(mocks.database).toHaveBeenCalledTimes(3);
	});

	it("keeps the database records when the regional bucket cannot be opened", async () => {
		const original = mocks.bucket.getMockImplementation();
		mocks.bucket.mockImplementation((bucket: Option.Option<string>) =>
			Option.getOrNull(bucket) === S3Bucket.TokyoBucketId
				? Effect.fail(new Error("Tokyo unavailable"))
				: original?.(bucket),
		);
		await expect(cleanup()).rejects.toThrow("Tokyo unavailable");
		expect(mocks.database).toHaveBeenCalledTimes(2);
	});
});
