import { Organisation, User } from "@cap/web-domain";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	selects: [] as unknown[][],
	inserts: [] as unknown[],
	updates: [] as unknown[],
	sequence: 0,
}));

vi.mock("server-only", () => ({}));
vi.mock("@cap/database/loops/queue", () => ({
	enqueueLoopsSync: vi.fn(async () => undefined),
}));
vi.mock("@cap/database/helpers", () => ({
	nanoIdLength: 15,
	nanoId: () => `idaaaaaaaaaaaa${++mocks.sequence}`,
}));
vi.mock("@cap/database", () => {
	const nextRows = async () => mocks.selects.shift() ?? [];
	const tx = {
		select: () => ({
			from: () => ({
				where: () => ({ limit: nextRows }),
				innerJoin: () => ({
					where: () => ({ limit: nextRows }),
				}),
			}),
		}),
		insert: () => ({
			values: async (value: unknown) => {
				mocks.inserts.push(value);
			},
		}),
		update: () => ({
			set: (value: unknown) => ({
				where: async () => {
					mocks.updates.push(value);
				},
			}),
		}),
	};
	return {
		db: () => ({
			transaction: async (callback: (value: typeof tx) => Promise<unknown>) =>
				callback(tx),
		}),
	};
});

import {
	InviteeRequiresAcceptanceError,
	provisionOrganizationInvitee,
} from "@/lib/organization-provisioning";

const organizationId = Organisation.OrganisationId.make("orgaaaaaaaaaaaa");
const invitedByUserId = User.UserId.make("adminaaaaaaaaaa");

function queueNewAddress(inviterEmail?: string, sameDomain = true) {
	mocks.selects = [
		...(inviterEmail ? [[{ email: inviterEmail }]] : []),
		...(inviterEmail && !sameDomain ? [[]] : []),
		[],
		[],
		[],
		[{ ownerId: invitedByUserId }],
		[
			{
				id: invitedByUserId,
				inviteQuota: 1,
				stripeSubscriptionId: null,
				stripeSubscriptionStatus: null,
			},
		],
	];
}

describe("provisionOrganizationInvitee", () => {
	beforeEach(() => {
		mocks.selects = [];
		mocks.inserts = [];
		mocks.updates = [];
		mocks.sequence = 0;
	});

	it("adds a new address on the inviter's company domain with the organization as its default", async () => {
		queueNewAddress("admin@acme.dev");

		const result = await provisionOrganizationInvitee({
			organizationId,
			email: "Teammate@acme.dev",
			invitedByUserId,
			role: "member",
		});

		expect(result).toMatchObject({ userCreated: true, memberCreated: true });
		expect(mocks.inserts).toEqual([
			expect.objectContaining({
				email: "teammate@acme.dev",
				activeOrganizationId: organizationId,
				defaultOrgId: organizationId,
			}),
			expect.objectContaining({
				organizationId,
				invitedEmail: "teammate@acme.dev",
				invitedByUserId,
			}),
			expect.objectContaining({ organizationId, role: "member" }),
		]);
	});

	it.each([
		["admin@acme.dev", "someone@elsewhere.dev"],
		["admin@gmail.com", "someone@gmail.com"],
	])("writes nothing when %s adds %s", async (inviterEmail, inviteeEmail) => {
		queueNewAddress(inviterEmail, false);

		await expect(
			provisionOrganizationInvitee({
				organizationId,
				email: inviteeEmail,
				invitedByUserId,
				role: "member",
			}),
		).rejects.toBeInstanceOf(InviteeRequiresAcceptanceError);
		expect(mocks.inserts).toEqual([]);
		expect(mocks.updates).toEqual([]);
	});

	it("writes nothing for an existing account outside the inviter's domain", async () => {
		mocks.selects = [
			[{ email: "admin@acme.dev" }],
			[],
			[{ id: "existingaaaaaaa", email: "someone@elsewhere.dev" }],
		];

		await expect(
			provisionOrganizationInvitee({
				organizationId,
				email: "someone@elsewhere.dev",
				invitedByUserId,
				role: "member",
			}),
		).rejects.toBeInstanceOf(InviteeRequiresAcceptanceError);
		expect(mocks.inserts).toEqual([]);
		expect(mocks.updates).toEqual([]);
	});

	it("leaves an address outside the inviter's domain alone when it is already a member", async () => {
		mocks.selects = [
			[{ email: "admin@acme.dev" }],
			[{ id: "memberaaaaaaaaa" }],
			[
				{
					id: "existingaaaaaaa",
					email: "someone@elsewhere.dev",
					name: "Someone",
					activeOrganizationId: organizationId,
					defaultOrgId: organizationId,
				},
			],
			[{ id: "memberaaaaaaaaa", hasProSeat: false }],
		];

		const result = await provisionOrganizationInvitee({
			organizationId,
			email: "someone@elsewhere.dev",
			invitedByUserId,
			role: "member",
		});

		expect(result).toMatchObject({
			userId: "existingaaaaaaa",
			userCreated: false,
			memberCreated: false,
		});
		expect(mocks.inserts).toEqual([]);
	});

	it("still adds any address for operator-approved imports", async () => {
		queueNewAddress();

		const result = await provisionOrganizationInvitee({
			organizationId,
			email: "someone@elsewhere.dev",
			invitedByUserId,
			role: "member",
			operatorApproved: true,
		});

		expect(result).toMatchObject({ userCreated: true, memberCreated: true });
		expect(mocks.inserts).toContainEqual(
			expect.objectContaining({ organizationId, role: "member" }),
		);
	});
});
