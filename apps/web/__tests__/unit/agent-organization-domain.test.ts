import * as Db from "@cap/database/schema";
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ checkDomainStatus: vi.fn() }));
const rows: unknown[][] = [];
const updates: Array<{ table: unknown; values: Record<string, unknown> }> = [];

function chain(result: unknown) {
	const builder = Object.assign(Promise.resolve(result), {
		from: () => builder,
		innerJoin: () => builder,
		leftJoin: () => builder,
		where: () => builder,
		limit: () => builder,
		for: () => builder,
	});
	return builder;
}

const fakeDb = {
	select: () => chain(rows.shift() ?? []),
	update: (table: unknown) => ({
		set: (values: Record<string, unknown>) => {
			updates.push({ table, values });
			return chain([{ affectedRows: 1 }]);
		},
	}),
	transaction: (run: (tx: unknown) => Promise<unknown>) => run(fakeDb),
};

vi.mock("@cap/database", () => ({ db: () => fakeDb }));
vi.mock("@cap/web-backend/src/Storage/index", () => ({ Storage: {} }));
vi.mock("@cap/web-backend/src/Organisations/index", () => ({
	Organisations: {},
}));
vi.mock("@/actions/organization/domain-utils", () => ({
	checkDomainStatus: mocks.checkDomainStatus,
	addDomain: async () => ({}),
}));
vi.mock("@/lib/ai-generation-entitlement", () => ({
	isAiGenerationEnabledForUser: () => true,
}));
vi.mock("@/lib/sync-video-storage-names", () => ({}));
vi.mock("@/lib/workflow-runtime", () => ({
	runWorkflowPromise: Effect.runPromise,
}));

import { agentCapOperationWorkflow } from "@/workflows/agent-cap-operation";

beforeEach(() => {
	updates.length = 0;
	mocks.checkDomainStatus.mockReset();
});

function prepare(kind: string) {
	rows.splice(
		0,
		rows.length,
		[
			{
				kind,
				state: "queued",
				payload: { organizationId: "org", domain: "videos.example.com" },
			},
		],
		[{ userId: "owner", ownerId: "owner", customDomain: "videos.example.com" }],
		[{ customDomain: "videos.example.com" }],
		[],
	);
}

describe.each(["set_organization_domain", "verify_organization_domain"])(
	"agent %s",
	(kind) => {
		it("leaves the domain unchanged and fails the operation when the lookup fails", async () => {
			prepare(kind);
			mocks.checkDomainStatus.mockResolvedValue({
				verified: false,
				error: "Failed to check domain status",
			});
			await expect(
				agentCapOperationWorkflow({ operationId: "operation" }),
			).rejects.toThrow("Failed to check domain status");
			expect(updates.filter(({ table }) => table === Db.organizations)).toEqual(
				[],
			);
			expect(updates.at(-1)?.values).toMatchObject({
				state: "failed",
				errorMessage: "Failed to check domain status",
			});
		});

		it.each([true, false])(
			"saves the provider's confirmed verification state %s",
			async (verified) => {
				prepare(kind);
				mocks.checkDomainStatus.mockResolvedValue({ verified });
				await agentCapOperationWorkflow({ operationId: "operation" });
				expect(
					updates.find(({ table }) => table === Db.organizations)?.values,
				).toMatchObject({
					customDomain: "videos.example.com",
					domainVerified: verified ? expect.any(Date) : null,
				});
				expect(updates.at(-1)?.values).toMatchObject({ state: "succeeded" });
			},
		);
	},
);
