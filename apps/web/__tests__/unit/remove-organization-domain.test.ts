import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	updates: [] as unknown[],
}));

vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: async () => ({ id: "owner" }),
}));

vi.mock("@cap/database", () => ({
	db: () => ({
		select: () => ({
			from: () => ({
				where: async () => [{ id: "org", customDomain: "video.example.com" }],
			}),
		}),
		update: () => ({
			set: (values: unknown) => ({
				where: async () => {
					mocks.updates.push(values);
				},
			}),
		}),
	}),
}));

vi.mock("@/actions/organization/authorization", () => ({
	requireOrganizationSettingsManager: async () => ({}),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import type { Organisation } from "@cap/web-domain";
import { removeOrganizationDomain } from "@/actions/organization/remove-domain";

const organizationId = "org" as Organisation.OrganisationId;

describe("removeOrganizationDomain", () => {
	beforeEach(() => {
		mocks.updates = [];
		vi.unstubAllGlobals();
	});

	it("keeps the domain when the provider rejects removal", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(new Response(null, { status: 403 })),
		);

		await expect(removeOrganizationDomain(organizationId)).rejects.toThrow();
		expect(mocks.updates).toEqual([]);
	});

	it("clears the domain after the provider removes it", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(new Response(null, { status: 204 })),
		);

		await expect(removeOrganizationDomain(organizationId)).resolves.toEqual({
			success: true,
		});
		expect(mocks.updates).toEqual([
			{ customDomain: null, domainVerified: null },
		]);
	});

	it("clears a domain that is already absent at the provider", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(new Response(null, { status: 404 })),
		);

		await expect(removeOrganizationDomain(organizationId)).resolves.toEqual({
			success: true,
		});
		expect(mocks.updates).toHaveLength(1);
	});
});
