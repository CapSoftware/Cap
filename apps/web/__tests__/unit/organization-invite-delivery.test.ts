import { Organisation } from "@cap/web-domain";
import type { SQL } from "drizzle-orm";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sendOrganizationInvites } from "@/actions/organization/send-invites";
import { provisionOrganizationInvitee } from "@/lib/organization-provisioning";
import { RATE_LIMIT_IDS } from "@/lib/rate-limit";

const mocks = vi.hoisted(() => ({
	sendEmail: vi.fn(),
	insert: vi.fn(),
	delete: vi.fn(),
	isRateLimited: vi.fn(),
	existingInviteEmails: [] as string[],
	existingMemberEmails: [] as string[],
	sequence: 0,
}));

vi.mock("@/lib/rate-limit", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/rate-limit")>()),
	isRateLimited: mocks.isRateLimited,
}));

vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: async () => ({ id: "user-1" }),
}));
vi.mock("@cap/database/emails/config", () => ({ sendEmail: mocks.sendEmail }));
vi.mock("@cap/database/emails/organization-invite", () => ({
	OrganizationInvite: (props: unknown) => props,
}));
vi.mock("@cap/database/helpers", () => ({
	nanoIdLength: 15,
	nanoId: () => `invite-${++mocks.sequence}`,
}));
vi.mock("@cap/env", () => ({
	serverEnv: () => ({ WEB_URL: "https://cap.example" }),
}));
vi.mock("@/lib/organization-provisioning", () => ({
	provisionOrganizationInvitee: vi.fn(),
}));
vi.mock("@/actions/organization/authorization", () => ({
	requireOrganizationSettingsManager: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@cap/database", () => {
	const tx = {
		select: () => ({
			from: () => ({
				where: async () =>
					mocks.existingInviteEmails.map((invitedEmail) => ({ invitedEmail })),
				innerJoin: () => ({
					where: async () =>
						mocks.existingMemberEmails.map((email) => ({ email })),
				}),
			}),
		}),
		insert: () => ({ values: mocks.insert }),
	};
	return {
		db: () => ({
			select: () => ({
				from: () => ({ where: async () => [{ id: "org-1", name: "Team" }] }),
			}),
			transaction: async (callback: (value: typeof tx) => Promise<unknown>) =>
				callback(tx),
			delete: () => ({ where: mocks.delete }),
		}),
	};
});

describe("organization invite delivery", () => {
	beforeEach(() => {
		mocks.sequence = 0;
		mocks.sendEmail.mockReset();
		mocks.insert.mockReset();
		mocks.delete.mockReset();
		mocks.isRateLimited.mockReset();
		mocks.isRateLimited.mockResolvedValue(false);
		mocks.existingInviteEmails = [];
		mocks.existingMemberEmails = [];
		vi.mocked(provisionOrganizationInvitee).mockReset();
	});

	it("preserves skipped invite records and reports them separately", async () => {
		mocks.sendEmail.mockResolvedValue({
			error: { name: "email_not_configured" },
		});
		const result = await sendOrganizationInvites(
			["person@example.com"],
			Organisation.OrganisationId.make("org-1"),
		);
		expect(result).toMatchObject({
			failedEmails: [],
			skippedEmails: ["person@example.com"],
		});
		expect(mocks.insert).toHaveBeenCalledWith([
			expect.objectContaining({
				id: "invite-1",
				invitedEmail: "person@example.com",
			}),
		]);
		expect(mocks.delete).not.toHaveBeenCalled();
	});

	it("cleans up only failed deliveries in a mixed batch", async () => {
		mocks.sendEmail
			.mockResolvedValueOnce({ error: { name: "email_not_configured" } })
			.mockResolvedValueOnce({ error: { name: "validation_error" } })
			.mockResolvedValueOnce({ data: { id: "sent" }, error: null });
		const result = await sendOrganizationInvites(
			["skipped@example.com", "failed@example.com", "sent@example.com"],
			Organisation.OrganisationId.make("org-1"),
		);
		expect(result).toMatchObject({
			failedEmails: ["failed@example.com"],
			skippedEmails: ["skipped@example.com"],
		});
		const condition = mocks.delete.mock.calls[0]?.[0] as SQL;
		expect(new MySqlDialect().sqlToQuery(condition).params).toEqual([
			"invite-2",
		]);
	});

	it("checks the invite send limit for the organization and the sender", async () => {
		mocks.sendEmail.mockResolvedValue({ data: { id: "sent" }, error: null });
		await sendOrganizationInvites(
			["person@example.com"],
			Organisation.OrganisationId.make("org-1"),
		);
		expect(RATE_LIMIT_IDS.ORGANIZATION_INVITE).toBeTypeOf("string");
		expect(mocks.isRateLimited).toHaveBeenCalledWith(
			RATE_LIMIT_IDS.ORGANIZATION_INVITE,
			{ key: "organization-invite:organization:org-1" },
		);
		expect(mocks.isRateLimited).toHaveBeenCalledWith(
			RATE_LIMIT_IDS.ORGANIZATION_INVITE,
			{ key: "organization-invite:user:user-1" },
		);
		expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
	});

	it.each([
		"organization-invite:organization:org-1",
		"organization-invite:user:user-1",
	])(
		"creates and emails nothing once %s is over the limit",
		async (limitedKey) => {
			mocks.isRateLimited.mockImplementation(
				async (_ruleId: string, opts?: { key?: string }) =>
					opts?.key === limitedKey,
			);
			await expect(
				sendOrganizationInvites(
					["one@example.com", "two@example.com"],
					Organisation.OrganisationId.make("org-1"),
				),
			).rejects.toThrow("Too many invites");
			expect(mocks.insert).not.toHaveBeenCalled();
			expect(mocks.sendEmail).not.toHaveBeenCalled();
		},
	);

	it("adds nothing without email notifications once over the limit", async () => {
		mocks.isRateLimited.mockResolvedValue(true);
		await expect(
			sendOrganizationInvites(
				["one@example.com"],
				Organisation.OrganisationId.make("org-1"),
				"member",
				{ sendEmailNotifications: false },
			),
		).rejects.toThrow("Too many invites");
		expect(provisionOrganizationInvitee).not.toHaveBeenCalled();
	});

	it("does not consult the limit when no address is valid", async () => {
		const result = await sendOrganizationInvites(
			["not-an-email"],
			Organisation.OrganisationId.make("org-1"),
		);
		expect(result).toMatchObject({ failedEmails: [], skippedEmails: [] });
		expect(mocks.isRateLimited).not.toHaveBeenCalled();
	});

	it("still skips addresses already invited or already members", async () => {
		mocks.existingInviteEmails = ["pending@example.com"];
		mocks.existingMemberEmails = ["member@example.com"];
		mocks.sendEmail.mockResolvedValue({ data: { id: "sent" }, error: null });
		await sendOrganizationInvites(
			["Pending@example.com", "member@example.com", "new@example.com"],
			Organisation.OrganisationId.make("org-1"),
		);
		expect(mocks.insert).toHaveBeenCalledWith([
			expect.objectContaining({ invitedEmail: "new@example.com" }),
		]);
		expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
		expect(mocks.sendEmail).toHaveBeenCalledWith(
			expect.objectContaining({ email: "new@example.com" }),
		);
	});

	it("still rejects batches over the per-call maximum", async () => {
		await expect(
			sendOrganizationInvites(
				Array.from({ length: 51 }, (_, i) => `person-${i}@example.com`),
				Organisation.OrganisationId.make("org-1"),
			),
		).rejects.toThrow("Cannot send more than 50 invites at once");
		expect(mocks.insert).not.toHaveBeenCalled();
	});
});
