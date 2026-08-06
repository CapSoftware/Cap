"use client";

import { buildEnv } from "@cap/env";
import { Card, CardDescription, CardHeader, CardTitle } from "@cap/ui";
import { useDashboardContext } from "@/app/(org)/dashboard/Contexts";
import {
	canManageOrganizationBilling,
	getEffectiveOrganizationRole,
} from "@/lib/permissions/roles";
import { BillingSummaryCard } from "../components/BillingSummaryCard";
import { MembersCard } from "../components/MembersCard";
import { SeatManagementCard } from "../components/SeatManagementCard";

export default function BillingAndMembersPage() {
	const { activeOrganization, user, setInviteDialogOpen } =
		useDashboardContext();
	const currentMember = activeOrganization?.members.find(
		(member) => member.userId === user.id,
	);
	const currentRole = getEffectiveOrganizationRole({
		userId: user.id,
		ownerId: activeOrganization?.organization.ownerId,
		memberRole: currentMember?.role,
	});
	const canManageBilling = canManageOrganizationBilling(currentRole);

	return (
		<div className="flex flex-col gap-6">
			{buildEnv.NEXT_PUBLIC_IS_CAP &&
				(canManageBilling ? (
					<>
						<BillingSummaryCard />
						{activeOrganization?.hasActiveProSeatProvider && (
							<SeatManagementCard />
						)}
					</>
				) : (
					<Card>
						<CardHeader>
							<CardTitle>Billing</CardTitle>
							<CardDescription>
								Billing is managed by the organization owner.
							</CardDescription>
						</CardHeader>
					</Card>
				))}
			<MembersCard setIsInviteDialogOpen={setInviteDialogOpen} />
		</div>
	);
}
