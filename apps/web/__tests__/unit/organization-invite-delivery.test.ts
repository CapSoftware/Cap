import { Organisation } from "@cap/web-domain";
import type { SQL } from "drizzle-orm";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sendOrganizationInvites } from "@/actions/organization/send-invites";

const mocks = vi.hoisted(() => ({
	sendEmail: vi.fn(),
	insert: vi.fn(),
	delete: vi.fn(),
	sequence: 0,
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
				where: async () => [],
				innerJoin: () => ({ where: async () => [] }),
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
});
