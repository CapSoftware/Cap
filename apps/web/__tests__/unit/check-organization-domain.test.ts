import { Organisation } from "@cap/web-domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkOrganizationDomain } from "@/actions/organization/check-domain";

const mocks = vi.hoisted(() => ({
	verifiedAt: new Date("2026-01-01T00:00:00Z") as Date | null,
	update: vi.fn(),
}));

vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: async () => ({ id: "owner" }),
}));

vi.mock("@cap/database", () => ({
	db: () => ({
		select: () => ({
			from: () => ({
				where: async () => [
					{
						id: "org",
						customDomain: "videos.example.com",
						domainVerified: mocks.verifiedAt,
					},
				],
			}),
		}),
		update: () => ({
			set: (values: unknown) => ({ where: () => mocks.update(values) }),
		}),
	}),
}));

vi.mock("@/actions/organization/authorization", () => ({
	requireOrganizationSettingsManager: vi.fn(),
}));

const organizationId = Organisation.OrganisationId.make("org");

function providerResponses(misconfigured: boolean) {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string) => {
			if (url.includes("/config?")) {
				return Response.json({ misconfigured });
			}
			if (url.includes("/records?")) return Response.json({ records: [] });
			return Response.json({ verified: true });
		}),
	);
}

describe("checkOrganizationDomain", () => {
	beforeEach(() => {
		mocks.verifiedAt = new Date("2026-01-01T00:00:00Z");
		mocks.update.mockReset();
		vi.spyOn(console, "error").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it.each(["network", "invalid JSON"])(
		"keeps verification on a %s failure and reports the lookup error",
		async (failure) => {
			vi.stubGlobal(
				"fetch",
				failure === "network"
					? vi.fn().mockRejectedValue(new Error("Network unavailable"))
					: vi
							.fn()
							.mockResolvedValue(
								new Response("Service unavailable", { status: 503 }),
							),
			);

			await expect(checkOrganizationDomain(organizationId)).rejects.toThrow(
				"Failed to check domain status",
			);
			expect(mocks.update).not.toHaveBeenCalled();
		},
	);

	it("keeps verification when the provider returns a JSON error", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				Response.json(
					{ error: { code: "internal_server_error", message: "Unavailable" } },
					{ status: 500 },
				),
			),
		);

		await expect(checkOrganizationDomain(organizationId)).rejects.toThrow(
			"Failed to check domain status",
		);
		expect(mocks.update).not.toHaveBeenCalled();
	});

	it("revokes verification when the provider no longer has the domain", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) => {
				if (url.includes("/config?")) {
					return Response.json({ misconfigured: false });
				}
				if (url.includes("/records?")) return Response.json({ records: [] });
				return Response.json(
					{ error: { code: "not_found", message: "Domain not found" } },
					{ status: 404 },
				);
			}),
		);

		await expect(
			checkOrganizationDomain(organizationId),
		).resolves.toMatchObject({ verified: false });
		expect(mocks.update).toHaveBeenCalledExactlyOnceWith({
			domainVerified: null,
		});
	});

	it("revokes verification when the provider confirms misconfiguration", async () => {
		providerResponses(true);

		await expect(
			checkOrganizationDomain(organizationId),
		).resolves.toMatchObject({ verified: false });
		expect(mocks.update).toHaveBeenCalledExactlyOnceWith({
			domainVerified: null,
		});
	});

	it("records verification when the provider confirms a new domain", async () => {
		mocks.verifiedAt = null;
		providerResponses(false);

		await expect(
			checkOrganizationDomain(organizationId),
		).resolves.toMatchObject({ verified: true });
		expect(mocks.update).toHaveBeenCalledExactlyOnceWith({
			domainVerified: expect.any(Date),
		});
	});

	it("keeps the existing timestamp for a domain that is still verified", async () => {
		providerResponses(false);

		await expect(
			checkOrganizationDomain(organizationId),
		).resolves.toMatchObject({ verified: true });
		expect(mocks.update).not.toHaveBeenCalled();
	});
});
