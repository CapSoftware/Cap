import { videos } from "@cap/database/schema";
import { Video } from "@cap/web-domain";
import { getTableColumns } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ query: vi.fn(), user: vi.fn() }));

vi.mock("@cap/database", async () => {
	const { drizzle } = await import("drizzle-orm/mysql-proxy");
	const client = drizzle(mocks.query);
	return { db: () => client };
});
vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: mocks.user,
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { shareCap } from "@/actions/caps/share";

const capId = Video.VideoId.make("video-1");
let organizationSettings: Record<string, unknown> | null;

beforeEach(() => {
	organizationSettings = { allowPublicLinkOverride: true };
	mocks.user.mockResolvedValue({ id: "caller" });
	mocks.query.mockReset();
	mocks.query.mockImplementation(async (query: string) => {
		if (/^(insert|update|delete) /.test(query)) {
			return { rows: [{ insertId: 0, affectedRows: 1 }] };
		}
		if (query.includes("where (false")) return { rows: [] };
		if (query.includes("from `videos`")) {
			const values: Record<string, unknown> = {
				id: capId,
				ownerId: "caller",
				orgId: "org-1",
			};
			return {
				rows: [
					Object.values(getTableColumns(videos)).map(
						(column) => values[column.name] ?? null,
					),
				],
			};
		}
		if (query.startsWith("select `settings` from `organizations`")) {
			return { rows: [[organizationSettings]] };
		}
		return { rows: [] };
	});
});

const writes = () =>
	mocks.query.mock.calls.filter(([query]) =>
		/^(insert|update|delete) /.test(query),
	);

describe("opening a single link to anyone", () => {
	it("stores the override alongside the visibility change", async () => {
		await expect(
			shareCap({ capId, spaceIds: [], public: true, linkAccess: "anyone" }),
		).resolves.toEqual({ success: true });
		expect(writes()).toHaveLength(1);
		expect(writes()[0]?.[0]).toContain("JSON_MERGE_PATCH");
		expect(writes()[0]?.[0]).toContain("`public` = ?");
		expect(writes()[0]?.[1]).toContain('{"linkAccess":"anyone"}');
	});

	it.each([null, {}, { allowPublicLinkOverride: false }])(
		"refuses before writing when the organization has %j",
		async (settings) => {
			organizationSettings = settings;
			await expect(
				shareCap({ capId, spaceIds: [], public: true, linkAccess: "anyone" }),
			).resolves.toMatchObject({ success: false });
			expect(writes()).toEqual([]);
		},
	);

	it("restores the restriction without touching visibility", async () => {
		await expect(
			shareCap({ capId, spaceIds: [], linkAccess: "restricted" }),
		).resolves.toEqual({ success: true });
		expect(writes()).toHaveLength(1);
		expect(writes()[0]?.[0]).not.toContain("`public` = ?");
		expect(writes()[0]?.[1]).toContain('{"linkAccess":null}');
	});

	it("clears the override when the link is turned off", async () => {
		await expect(
			shareCap({ capId, spaceIds: [], public: false, linkAccess: "anyone" }),
		).resolves.toEqual({ success: true });
		expect(writes()).toHaveLength(1);
		expect(writes()[0]?.[1]).toContain('{"linkAccess":null}');
	});

	it("leaves settings alone when no link access is sent", async () => {
		await expect(
			shareCap({ capId, spaceIds: [], public: true }),
		).resolves.toEqual({ success: true });
		expect(writes()).toHaveLength(1);
		expect(writes()[0]?.[0]).not.toContain("JSON_MERGE_PATCH");
		expect(
			mocks.query.mock.calls.some(([query]) =>
				query.startsWith("select `settings` from `organizations`"),
			),
		).toBe(false);
	});
});
