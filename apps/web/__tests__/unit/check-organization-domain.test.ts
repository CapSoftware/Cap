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

const txtVerification = [
	{
		type: "TXT",
		domain: "_vercel.example.com",
		value: "vc-domain-verify=videos.example.com,abc123",
		reason: "pending_domain_verification",
	},
];

function providerResponses({
	misconfigured = false,
	domain = () => Response.json({ verified: true }),
	verify = () => Response.json({ verified: true }),
}: {
	misconfigured?: boolean;
	domain?: () => Response;
	verify?: () => Response;
} = {}) {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string) => {
			if (url.includes("/config?")) {
				return Response.json({ misconfigured });
			}
			if (url.includes("/records?")) return Response.json({ records: [] });
			if (url.includes("/verify?")) return verify();
			return domain();
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

	it("keeps verification and reports the lookup error when fetch fails", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockRejectedValue(new Error("Network unavailable")),
		);

		await expect(checkOrganizationDomain(organizationId)).rejects.toThrow(
			"Failed to check domain status",
		);
		expect(mocks.update).not.toHaveBeenCalled();
	});

	it.each([
		["a text", () => new Response("Service unavailable", { status: 503 })],
		[
			"a JSON",
			() =>
				Response.json(
					{ error: { code: "internal_server_error", message: "Unavailable" } },
					{ status: 500 },
				),
		],
	])(
		"keeps verification when verify returns %s 5xx error",
		async (_body, verify) => {
			providerResponses({
				domain: () =>
					Response.json({
						verified: false,
						verification: txtVerification,
					}),
				verify,
			});

			await expect(checkOrganizationDomain(organizationId)).rejects.toThrow(
				"Failed to check domain status",
			);
			expect(mocks.update).not.toHaveBeenCalled();
		},
	);

	it("keeps a domain waiting on its TXT record unverified with its instructions", async () => {
		mocks.verifiedAt = null;
		providerResponses({
			domain: () =>
				Response.json({
					verified: false,
					verification: txtVerification,
				}),
			verify: () =>
				Response.json(
					{
						error: {
							code: "missing_txt_record",
							message: "Domain is missing its TXT verification record",
						},
					},
					{ status: 400 },
				),
		});

		await expect(
			checkOrganizationDomain(organizationId),
		).resolves.toMatchObject({
			verified: false,
			config: { verification: txtVerification },
		});
		expect(mocks.update).not.toHaveBeenCalled();
	});

	it("revokes verification when the provider no longer has the domain", async () => {
		providerResponses({
			domain: () =>
				Response.json(
					{ error: { code: "not_found", message: "Domain not found" } },
					{ status: 404 },
				),
		});

		await expect(
			checkOrganizationDomain(organizationId),
		).resolves.toMatchObject({ verified: false });
		expect(mocks.update).toHaveBeenCalledExactlyOnceWith({
			domainVerified: null,
		});
	});

	it("revokes verification when the provider confirms misconfiguration", async () => {
		providerResponses({ misconfigured: true });

		await expect(
			checkOrganizationDomain(organizationId),
		).resolves.toMatchObject({ verified: false });
		expect(mocks.update).toHaveBeenCalledExactlyOnceWith({
			domainVerified: null,
		});
	});

	it("records verification when the provider confirms a new domain", async () => {
		mocks.verifiedAt = null;
		providerResponses();

		await expect(
			checkOrganizationDomain(organizationId),
		).resolves.toMatchObject({ verified: true });
		expect(mocks.update).toHaveBeenCalledExactlyOnceWith({
			domainVerified: expect.any(Date),
		});
	});

	it("keeps the existing timestamp for a domain that is still verified", async () => {
		providerResponses();

		await expect(
			checkOrganizationDomain(organizationId),
		).resolves.toMatchObject({ verified: true });
		expect(mocks.update).not.toHaveBeenCalled();
	});
});
